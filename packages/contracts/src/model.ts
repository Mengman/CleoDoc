export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: readonly ModelToolCall[];
}

export interface ModelToolDefinition {
  name: string;
  description: string;
  inputSchema: Readonly<Record<string, unknown>>;
}

export interface ModelRequest {
  model: string;
  messages: readonly ChatMessage[];
  tools?: readonly ModelToolDefinition[];
  temperature?: number;
  maxTokens?: number;
}

export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface ModelToolCall {
  id: string;
  name: string;
  argumentsJson: string;
}

export type ModelEvent =
  | { type: "text-delta"; text: string }
  | { type: "tool-call"; call: ModelToolCall }
  | { type: "usage"; usage: ModelUsage }
  | { type: "done"; finishReason?: string };

export interface ProviderHealth {
  ok: boolean;
  message: string;
  models?: readonly string[];
}

export interface ModelProvider {
  readonly id: string;
  readonly displayName: string;
  validateConfiguration(signal?: AbortSignal): Promise<ProviderHealth>;
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent>;
}
