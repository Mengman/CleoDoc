import type { ModelToolCall, StoredMessage } from "../../../contracts/src/index.js";
import { asAppError } from "../../../contracts/src/index.js";
import { toolKey, type ProjectToolCatalog, type ProjectToolInfo } from "./project-tool-catalog.js";
import {
  toolFailure,
  toolIdentity,
  toolSuccess,
  wrapToolResult,
  type ToolApprovalHandler,
  type ToolExecutionContext,
  type ToolIdentity,
  type ToolOutcome,
  type UnknownTool,
} from "./tool-contract.js";

export interface ProjectToolRuntimeOptions {
  toolStateMessages?: readonly StoredMessage[];
}

export class ProjectToolRuntime {
  private readonly conversationApprovalsUntilExit = new Set<string>();
  private readonly loadedToolVersions = new Set<string>();

  constructor(
    readonly context: ToolExecutionContext,
    private readonly catalog: ProjectToolCatalog,
    options: ProjectToolRuntimeOptions = {},
  ) {
    for (const tool of readLoadedToolIdentities(options.toolStateMessages ?? [])) {
      this.loadedToolVersions.add(toolKey(tool));
    }
  }

  get toolInfo(): ProjectToolInfo {
    return this.catalog.getToolInfo(this.loadedToolVersions);
  }

  async execute(call: ModelToolCall, approve?: ToolApprovalHandler): Promise<string> {
    const resolved = this.catalog.getToolOrSelf(call.name);
    const tool =
      resolved !== undefined &&
      (resolved.exposure === "full" || this.loadedToolVersions.has(toolKey(resolved)))
        ? resolved
        : undefined;
    if (tool === undefined) {
      return JSON.stringify(
        wrapToolResult(
          { name: call.name, version: resolved?.version ?? 0 },
          toolFailure(
            "TOOL_NOT_FOUND",
            "找不到当前项目可调用的指定 Tool。",
            "使用 project_tool_catalog 的 list 和 get 操作查看并加载 Tool。",
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

    const approval = await this.checkApproval(tool, parsed.data, approve);
    if (approval !== null) return this.serialize(tool, approval);

    try {
      const outcome = await tool.execute(parsed.data, this.context);
      if (!outcome.ok) return this.serialize(tool, outcome);

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
      this.rememberCatalogLoad(tool, output.data);
      return this.serialize(tool, toolSuccess(output.data));
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
      const tool = this.catalog.getToolOrSelf(name);
      const call = message.toolCallId === undefined ? undefined : calls.get(message.toolCallId);
      const result = parseStoredToolResult(message.content);
      if (tool === undefined || call === undefined || result === null) {
        events.push(genericStoredToolEvent(name, result));
        continue;
      }
      if (tool.name === this.catalog.name) continue;
      if (result.identity.name !== tool.name || result.identity.version !== tool.version) {
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
    approve: ToolApprovalHandler | undefined,
  ): Promise<ToolOutcome<never> | null> {
    if (tool.approval === "auto") return null;
    if (tool.approval === "deny") {
      return toolFailure("USER_REJECTED", "当前 Tool 被固定审批规则禁止执行。");
    }
    const key = toolKey(tool);
    if (this.conversationApprovalsUntilExit.has(key)) return null;
    if (approve === undefined) {
      return toolFailure(
        "USER_APPROVAL_REQUIRED",
        "当前环境不能取得本次 Tool 调用所需的用户审批。",
        "在交互聊天中重试并由用户批准。",
      );
    }
    const choice = await approve({
      toolName: tool.name,
      toolVersion: tool.version,
      input,
    });
    if (choice === "reject") {
      return toolFailure("USER_REJECTED", "用户拒绝了本次 Tool 调用。");
    }
    if (choice === "allow_until_exit") this.conversationApprovalsUntilExit.add(key);
    return null;
  }

  private rememberCatalogLoad(tool: UnknownTool, output: unknown): void {
    if (tool.name !== this.catalog.name || !isRecord(output) || output.action !== "get") return;
    if (!isRecord(output.tool)) return;
    const name = output.tool.name;
    const version = output.tool.version;
    if (typeof name === "string" && typeof version === "number") {
      this.loadedToolVersions.add(toolKey({ name, version }));
    }
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
): { identity: ToolIdentity; outcome: ToolOutcome<unknown> } | null {
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
    if (message.role !== "tool" || message.name !== "project_tool_catalog") continue;
    const result = parseJson(message.content);
    if (!isRecord(result) || result.ok !== true || !isRecord(result.data)) continue;
    if (result.data.action !== "get" || !isRecord(result.data.tool)) continue;
    const name = result.data.tool.name;
    const version = result.data.tool.version;
    if (typeof name === "string" && typeof version === "number") loaded.push({ name, version });
  }
  return loaded;
}
