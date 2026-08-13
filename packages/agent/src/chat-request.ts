import type {
  ContextBudgetPolicy,
  ModelEvent,
  ModelRequest,
  ModelUsage,
} from "../../contracts/src/index.js";
import type { ModelMessageSender } from "../../contracts/src/index.js";
import type { LlmDebugHandler } from "./debug-events.js";
import type { ToolApprovalHandler } from "./tool/index.js";

export const DEFAULT_SYSTEM_PROMPT = `你是 CleoDoc 的中文小说主笔。你与用户讨论创作委托，给出完整、可保存的中文内容。明确区分用户决定、已知资料与创作假设。

你可以使用项目工具列出、分段读取和写入 manuscript 中的 Markdown 文档。只有在确实需要项目内容时才读取；不要声称读取了未通过工具获得的资料。当用户明确要求“保存、写入、记录到项目”时，应调用 write_project_document，而不是只在聊天中展示内容。写入会由 CleoDoc 请求用户确认，拒绝后不得绕过。不得覆盖已有文档，除非用户明确要求覆盖并再次批准。

项目指令是跨对话生效的项目级长期规则。需要查看或修改时使用项目指令工具；修改前必须先读取当前项目指令。追加和全量替换都会要求用户批准，拒绝后不得绕过。

只有累计摘要缺少完成当前任务所需的精确细节时，才使用会话历史查询工具。不得为了全面了解而批量读取全部历史。

需要项目资料时使用知识检索工具。不清楚资料语言时先调用 list_materials；search_knowledge 的 query 必须使用目标资料的语言。需要限定一份资料时，必须把 list_materials 返回的唯一 title 原样传给 search_knowledge；read_material_context 必须原样使用同一搜索结果中的 title 和 chunkId。只有检索片段缺少必要前后文时才调用 read_material_context。不得声称使用了未通过 Tool 获得的资料。`;

export interface SendMessageInput {
  conversationId?: string;
  projectId: string;
  provider: ModelMessageSender;
  model: string;
  prompt: string;
  signal: AbortSignal;
  onEvent?: (event: ModelEvent) => void;
  approveToolCall?: ToolApprovalHandler;
  contextBudgetPolicy?: ContextBudgetPolicy;
  onDebugEvent?: LlmDebugHandler;
}

export function describeModelRequest(request: ModelRequest): Readonly<Record<string, unknown>> {
  return {
    thinking: request.thinking?.type ?? "provider_default",
    reasoningEffort: "provider_default",
    temperature: request.temperature ?? null,
    maxTokens: request.maxTokens ?? null,
    responseFormat: request.responseFormat ?? null,
    toolsEnabled: (request.tools?.length ?? 0) > 0,
    toolCount: request.tools?.length ?? 0,
    toolNames: request.tools?.map((tool) => tool.name) ?? [],
    toolVersions: request.tools?.map((tool) => ({ name: tool.name, version: tool.version })) ?? [],
  };
}

export function modelRequestForBudget(request: ModelRequest): Record<string, unknown> {
  return {
    model: request.model,
    messages: request.messages.map((message) => {
      const { reasoningContent, ...base } = message;
      return message.role === "assistant" && message.toolCalls !== undefined
        ? { ...base, ...(reasoningContent === undefined ? {} : { reasoningContent }) }
        : base;
    }),
    tools: request.tools,
    temperature: request.temperature,
    maxTokens: request.maxTokens,
    responseFormat: request.responseFormat,
    thinking: request.thinking,
  };
}

export function mergeUsage(current: ModelUsage | undefined, next: ModelUsage): ModelUsage {
  return {
    inputTokens: mergeTokenCount(current?.inputTokens, next.inputTokens),
    outputTokens: mergeTokenCount(current?.outputTokens, next.outputTokens),
    reasoningTokens: mergeTokenCount(current?.reasoningTokens, next.reasoningTokens),
    totalTokens: mergeTokenCount(current?.totalTokens, next.totalTokens),
  };
}

export function parseToolResponseError(result: string): { code: string; message: string } | null {
  try {
    const parsed = JSON.parse(result) as {
      ok?: boolean;
      error?: { code?: unknown; message?: unknown };
    };
    return parsed.ok === false &&
      typeof parsed.error?.code === "string" &&
      typeof parsed.error.message === "string"
      ? { code: parsed.error.code, message: parsed.error.message }
      : null;
  } catch {
    return null;
  }
}

function mergeTokenCount(
  current: number | undefined,
  next: number | undefined,
): number | undefined {
  return current === undefined && next === undefined ? undefined : (current ?? 0) + (next ?? 0);
}
