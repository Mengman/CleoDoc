import type { ModelToolCall, StoredMessage } from "../../../contracts/src/index.js";
import { asAppError } from "../../../contracts/src/index.js";
import type {
  ProjectInstructionRepository,
  SessionRepository,
} from "../../../database/src/index.js";
import { DocumentService } from "../../../project/src/index.js";
import {
  ReadConversationMessageTool,
  SearchConversationHistoryTool,
} from "./conversation-history-tools.js";
import {
  ListProjectDocumentsTool,
  ReadProjectDocumentTool,
  WriteProjectDocumentTool,
} from "./document-tools.js";
import { GetToolTool, ListToolsTool } from "./meta-tools.js";
import {
  AppendProjectInstructionsTool,
  ReadProjectInstructionsTool,
  SetProjectInstructionsTool,
} from "./project-instructions-tools.js";
import {
  toolFailure,
  toolIdentity,
  toolSuccess,
  wrapToolResult,
  type ToolApprovalHandler,
  type ToolIdentity,
  type ToolOutcome,
} from "./tool-contract.js";
import { ToolRegistry, type UnknownTool } from "./tool-registry.js";

export interface ProjectToolRuntimeOptions {
  approve?: ToolApprovalHandler;
  approvedUntilExit?: Set<string>;
  history?: {
    repository: SessionRepository;
    conversationId: string;
  };
  projectInstructions?: ProjectInstructionRepository;
  toolStateMessages?: readonly StoredMessage[];
}

export class ProjectToolRuntime {
  private readonly registry: ToolRegistry;
  private readonly approvedUntilExit: Set<string>;

  constructor(
    projectRoot: string,
    private readonly options: ProjectToolRuntimeOptions = {},
  ) {
    this.registry = new ToolRegistry(readLoadedToolIdentities(options.toolStateMessages ?? []));
    this.approvedUntilExit = options.approvedUntilExit ?? new Set<string>();
    const documents = new DocumentService(projectRoot);
    this.registry.register(new ListProjectDocumentsTool(documents));
    this.registry.register(new ReadProjectDocumentTool(documents));
    this.registry.register(new WriteProjectDocumentTool(documents));

    if (options.projectInstructions !== undefined) {
      this.registry.register(new ReadProjectInstructionsTool(options.projectInstructions));
      this.registry.register(new AppendProjectInstructionsTool(options.projectInstructions));
      this.registry.register(new SetProjectInstructionsTool(options.projectInstructions));
    }
    if (options.history !== undefined) {
      this.registry.register(
        new SearchConversationHistoryTool(
          options.history.repository,
          options.history.conversationId,
        ),
      );
      this.registry.register(
        new ReadConversationMessageTool(options.history.repository, options.history.conversationId),
      );
    }

    this.registry.register(new ListToolsTool(this.registry));
    this.registry.register(new GetToolTool(this.registry));
  }

  get definitions() {
    return this.registry.getProviderDefinitions();
  }

  get disclosurePrompt(): string {
    return this.registry.getDisclosurePrompt();
  }

  async execute(call: ModelToolCall): Promise<string> {
    const tool = this.registry.getCallable(call.name);
    if (tool === undefined) {
      return JSON.stringify(
        wrapToolResult(
          { name: call.name, version: 0 },
          toolFailure(
            "TOOL_NOT_FOUND",
            "找不到当前任务可用的指定 Tool。",
            "调用 list_tools 查看当前可用 Tool。",
          ),
        ),
      );
    }

    let rawInput: unknown;
    try {
      rawInput = JSON.parse(call.argumentsJson) as unknown;
    } catch {
      return this.serialize(
        tool,
        toolFailure(
          "INVALID_TOOL_INPUT",
          "Tool Call 参数不是有效 JSON。",
          "根据 Tool Input Schema 重新生成参数。",
        ),
      );
    }
    const parsed = tool.inputSchema.safeParse(rawInput);
    if (!parsed.success) {
      return this.serialize(
        tool,
        toolFailure(
          "INVALID_TOOL_INPUT",
          "Tool Call 参数未通过 Input Schema 校验。",
          "根据 Tool Input Schema 修正参数后重试。",
        ),
      );
    }

    const approval = await this.checkApproval(tool, parsed.data);
    if (approval !== null) return this.serialize(tool, approval);

    try {
      const outcome = await tool.execute(parsed.data);
      if (outcome.ok) {
        const output = tool.outputSchema.safeParse(outcome.data);
        if (!output.success) {
          return this.serialize(
            tool,
            toolFailure(
              "TOOL_EXECUTION_FAILED",
              "Tool 成功结果未通过 Output Schema 校验。",
              "停止自动重试并向用户报告。",
            ),
          );
        }
        return this.serialize(tool, toolSuccess(output.data));
      }
      return this.serialize(tool, outcome);
    } catch (error) {
      const appError = asAppError(error);
      const definition = tool.errors.find((candidate) => candidate.code === appError.code);
      return this.serialize(
        tool,
        toolFailure(
          appError.code === "VALIDATION_ERROR" ? "TOOL_EXECUTION_FAILED" : appError.code,
          appError.message,
          definition?.recovery ?? "停止自动重试并向用户报告。",
        ),
      );
    }
  }

  projectToolEventsForCompaction(
    messages: readonly StoredMessage[],
  ): Array<Record<string, unknown>> {
    const calls = new Map<string, ModelToolCall>();
    for (const message of messages) {
      if (message.role !== "assistant" || message.toolCalls === undefined) continue;
      for (const call of message.toolCalls) calls.set(call.id, call);
    }

    const events: Array<Record<string, unknown>> = [];
    for (const message of messages) {
      if (message.role !== "tool") continue;
      const name = message.name ?? "unknown";
      const tool = this.registry.get(name);
      const call = message.toolCallId === undefined ? undefined : calls.get(message.toolCallId);
      const result = parseStoredToolResult(message.content);
      if (tool === undefined || call === undefined || result === null) {
        events.push(genericStoredToolEvent(name, result));
        continue;
      }
      const input = tool.inputSchema.safeParse(parseJson(call.argumentsJson));
      if (!input.success) {
        events.push(genericStoredToolEvent(name, result));
        continue;
      }
      const projection = tool.getCompactionMessage(input.data, result.outcome);
      if (projection === null) continue;
      const parsedProjection = parseJson(projection);
      if (isRecord(parsedProjection)) events.push(parsedProjection);
    }
    return events;
  }

  private async checkApproval(
    tool: UnknownTool,
    input: unknown,
  ): Promise<ToolOutcome<never> | null> {
    if (tool.approval === "auto") return null;
    if (tool.approval === "deny") {
      return toolFailure("USER_REJECTED", "当前 Tool 被固定审批规则禁止执行。");
    }
    const key = `${tool.name}@${tool.version}`;
    if (this.approvedUntilExit.has(key)) return null;
    if (this.options.approve === undefined) {
      return toolFailure(
        "USER_APPROVAL_REQUIRED",
        "当前环境不能取得本次 Tool 调用所需的用户审批。",
        "在交互聊天中重试并由用户批准。",
      );
    }
    const choice = await this.options.approve({
      toolName: tool.name,
      toolVersion: tool.version,
      input,
    });
    if (choice === "reject") {
      return toolFailure("USER_REJECTED", "用户拒绝了本次 Tool 调用。");
    }
    if (choice === "allow_until_exit") this.approvedUntilExit.add(key);
    return null;
  }

  private serialize(tool: UnknownTool, outcome: ToolOutcome<unknown>): string {
    return JSON.stringify(wrapToolResult(toolIdentity(tool), outcome));
  }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function parseStoredToolResult(
  content: string,
): { identity: { name: string; version: number }; outcome: ToolOutcome<unknown> } | null {
  const value = parseJson(content);
  if (!isRecord(value) || !isRecord(value.tool)) return null;
  const name = value.tool.name;
  const version = value.tool.version;
  if (typeof name !== "string" || typeof version !== "number") return null;
  if (value.ok === true && "data" in value) {
    return { identity: { name, version }, outcome: toolSuccess(value.data) };
  }
  if (value.ok === false && isRecord(value.error) && typeof value.error.code === "string") {
    return {
      identity: { name, version },
      outcome: toolFailure(
        value.error.code,
        typeof value.error.message === "string" ? value.error.message : "Tool 执行失败。",
        typeof value.error.recovery === "string" ? value.error.recovery : undefined,
      ),
    };
  }
  return null;
}

function genericStoredToolEvent(
  name: string,
  result: ReturnType<typeof parseStoredToolResult>,
): Record<string, unknown> {
  return {
    tool: result?.identity ?? { name, version: 0 },
    status: result === null ? "unknown" : result.outcome.ok ? "completed" : "failed",
    ...(result?.outcome.ok === false ? { errorCode: result.outcome.error.code } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readLoadedToolIdentities(messages: readonly StoredMessage[]): ToolIdentity[] {
  const loaded: ToolIdentity[] = [];
  for (const message of messages) {
    if (message.role !== "tool" || message.name !== "get_tool") continue;
    const result = parseJson(message.content);
    if (!isRecord(result) || result.ok !== true || !isRecord(result.data)) continue;
    const tool = result.data.tool;
    if (!isRecord(tool) || typeof tool.name !== "string" || typeof tool.version !== "number") {
      continue;
    }
    loaded.push({ name: tool.name, version: tool.version });
  }
  return loaded;
}
