export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  reasoningContent?: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: readonly ModelToolCall[];
}

export interface ModelToolDefinition {
  name: string;
  version: number;
  description: string;
  inputSchema: Readonly<Record<string, unknown>>;
}

export type ModelProtocolEvent =
  | {
      type: "request";
      method: string;
      url: string;
      headers: Readonly<Record<string, string>>;
      body: string;
    }
  | {
      type: "response-head";
      status: number;
      statusText: string;
      headers: Readonly<Record<string, string>>;
    }
  | { type: "response-chunk"; chunk: string };

export type ModelProtocolDebugHandler = (event: ModelProtocolEvent) => void;

export interface ModelResponseFormat {
  type: "json_object";
}

export interface ModelThinkingMode {
  type: "enabled" | "disabled";
}

export interface ModelRequest {
  model: string;
  messages: readonly ChatMessage[];
  tools?: readonly ModelToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  responseFormat?: ModelResponseFormat;
  thinking?: ModelThinkingMode;
  onProtocolEvent?: ModelProtocolDebugHandler;
}

export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
}

export interface ModelToolCall {
  id: string;
  name: string;
  argumentsJson: string;
}

export type ModelEvent =
  | { type: "reasoning-delta"; text: string }
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
