import { z } from "zod";

import type {
  ChatMessage,
  ModelEvent,
  ModelProvider,
  ModelRequest,
  ModelToolCall,
  ProviderHealth,
} from "../../contracts/src/index.js";
import { AppError } from "../../contracts/src/index.js";
import {
  mapProviderFailure,
  ProviderStreamTimeoutController,
  throwForProviderResponse,
  withTimeout,
  type ProviderStreamTimeoutOptions,
} from "./http-errors.js";
import { emitProtocolEvent, redactHeaders } from "./protocol-debug.js";

const modelListSchema = z.object({
  data: z.array(z.object({ id: z.string() }).passthrough()),
});

const streamChunkSchema = z
  .object({
    choices: z
      .array(
        z
          .object({
            delta: z
              .object({
                content: z.string().nullable().optional(),
                reasoning_content: z.string().nullable().optional(),
                tool_calls: z
                  .array(
                    z
                      .object({
                        index: z.number().int().nonnegative(),
                        id: z.string().optional(),
                        function: z
                          .object({
                            name: z.string().optional(),
                            arguments: z.string().optional(),
                          })
                          .optional(),
                      })
                      .passthrough(),
                  )
                  .optional(),
              })
              .passthrough(),
            finish_reason: z.string().nullable().optional(),
          })
          .passthrough(),
      )
      .default([]),
    usage: z
      .object({
        prompt_tokens: z.number().optional(),
        completion_tokens: z.number().optional(),
        total_tokens: z.number().optional(),
        completion_tokens_details: z
          .object({ reasoning_tokens: z.number().optional() })
          .passthrough()
          .nullable()
          .optional(),
      })
      .nullable()
      .optional(),
  })
  .passthrough();

export interface OpenAICompatibleProviderOptions extends ProviderStreamTimeoutOptions {
  apiKey?: string;
  baseUrl: string;
  fetchImplementation?: typeof fetch;
}

export class OpenAICompatibleProvider implements ModelProvider {
  readonly id = "openai-compatible";
  readonly displayName = "OpenAI-compatible";
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly streamTimeouts: ProviderStreamTimeoutOptions;
  private readonly fetchImplementation: typeof fetch;

  constructor(options: OpenAICompatibleProviderOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.streamTimeouts = {
      connectionTimeoutMs: options.connectionTimeoutMs,
      streamIdleTimeoutMs: options.streamIdleTimeoutMs,
      overallTimeoutMs: options.overallTimeoutMs,
    };
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    if (!this.apiKey) {
      throw new AppError("PROVIDER_AUTH_ERROR", "未设置 CLEODOC_API_KEY。");
    }
  }

  async validateConfiguration(callerSignal?: AbortSignal): Promise<ProviderHealth> {
    const requestSignal = withTimeout(
      callerSignal,
      Math.min(this.streamTimeouts.connectionTimeoutMs, 30_000),
    );
    try {
      const response = await this.fetchImplementation(`${this.baseUrl}/models`, {
        headers: this.headers(),
        signal: requestSignal,
      });
      if (!response.ok) {
        await throwForProviderResponse(response);
      }
      const parsed = modelListSchema.safeParse(await response.json());
      return parsed.success
        ? {
            ok: true,
            message: "连接成功。",
            models: parsed.data.data.slice(0, 20).map((model) => model.id),
          }
        : { ok: true, message: "连接成功，但模型列表格式不是标准 OpenAI 格式。" };
    } catch (error) {
      throw mapProviderFailure(error, callerSignal, requestSignal);
    }
  }

  async *stream(request: ModelRequest, callerSignal: AbortSignal): AsyncIterable<ModelEvent> {
    const timeouts = new ProviderStreamTimeoutController(callerSignal, this.streamTimeouts);
    const requestSignal = timeouts.signal;
    const toolCalls = new Map<number, ModelToolCall>();
    let finishReason: string | undefined;

    try {
      const url = `${this.baseUrl}/chat/completions`;
      const headers = this.headers();
      const body = JSON.stringify({
        model: request.model,
        messages: request.messages.map(toOpenAIMessage),
        stream: true,
        stream_options: { include_usage: true },
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
        ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens }),
        ...(request.responseFormat === undefined
          ? {}
          : { response_format: request.responseFormat }),
        ...(request.thinking === undefined ? {} : { thinking: request.thinking }),
        ...(request.tools === undefined
          ? {}
          : {
              tools: request.tools.map((tool) => ({
                type: "function",
                function: {
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.inputSchema,
                },
              })),
            }),
      });
      emitProtocolEvent(request, {
        type: "request",
        method: "POST",
        url,
        headers: redactHeaders(headers),
        body,
      });
      const response = await this.fetchImplementation(url, {
        method: "POST",
        headers,
        body,
        signal: requestSignal,
      });
      timeouts.markConnected();
      emitProtocolEvent(request, {
        type: "response-head",
        status: response.status,
        statusText: response.statusText,
        headers: redactHeaders(response.headers),
      });
      if (!response.ok) {
        await throwForProviderResponse(response, (responseBody) =>
          emitProtocolEvent(request, { type: "response-chunk", chunk: responseBody }),
        );
      }
      if (response.body === null) {
        throw new AppError("PROVIDER_UNAVAILABLE", "模型服务没有返回响应流。");
      }

      for await (const data of readServerSentEvents(
        response.body,
        requestSignal,
        () => timeouts.markActivity(),
        (chunk) => emitProtocolEvent(request, { type: "response-chunk", chunk }),
      )) {
        if (data === "[DONE]") {
          break;
        }
        let parsedJson: unknown;
        try {
          parsedJson = JSON.parse(data) as unknown;
        } catch (error) {
          throw new AppError("PROVIDER_UNAVAILABLE", "模型流式响应不是有效的 JSON。", {
            cause: error,
            details: {
              responseStage: "stream_json_parse",
              parserMessage: error instanceof Error ? error.message : String(error),
              dataPreview: data.slice(0, 500),
            },
          });
        }
        const parsed = streamChunkSchema.safeParse(parsedJson);
        if (!parsed.success) {
          throw new AppError("PROVIDER_UNAVAILABLE", "模型流式响应格式无效。", {
            details: {
              responseStage: "stream_schema_validation",
              issues: parsed.error.issues,
              dataPreview: data.slice(0, 500),
            },
          });
        }

        for (const choice of parsed.data.choices) {
          if (choice.delta.reasoning_content) {
            yield { type: "reasoning-delta", text: choice.delta.reasoning_content };
          }
          if (choice.delta.content) {
            yield { type: "text-delta", text: choice.delta.content };
          }
          if (choice.finish_reason) {
            finishReason = choice.finish_reason;
          }
          for (const delta of choice.delta.tool_calls ?? []) {
            const current = toolCalls.get(delta.index) ?? {
              id: delta.id ?? `tool_${delta.index}`,
              name: "",
              argumentsJson: "",
            };
            toolCalls.set(delta.index, {
              id: delta.id ?? current.id,
              name: `${current.name}${delta.function?.name ?? ""}`,
              argumentsJson: `${current.argumentsJson}${delta.function?.arguments ?? ""}`,
            });
          }
        }

        if (parsed.data.usage) {
          yield {
            type: "usage",
            usage: {
              inputTokens: parsed.data.usage.prompt_tokens,
              outputTokens: parsed.data.usage.completion_tokens,
              reasoningTokens: parsed.data.usage.completion_tokens_details?.reasoning_tokens,
              totalTokens: parsed.data.usage.total_tokens,
            },
          };
        }
      }

      for (const call of [...toolCalls.entries()].sort(([left], [right]) => left - right)) {
        yield { type: "tool-call", call: call[1] };
      }
      yield { type: "done", ...(finishReason === undefined ? {} : { finishReason }) };
    } catch (error) {
      throw mapProviderFailure(error, callerSignal, requestSignal, timeouts.timeoutKind);
    } finally {
      timeouts.dispose();
    }
  }

  private headers(): Record<string, string> {
    return {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(this.apiKey === undefined ? {} : { Authorization: `Bearer ${this.apiKey}` }),
    };
  }
}

function toOpenAIMessage(message: ChatMessage): Record<string, unknown> {
  if (message.role === "assistant" && message.toolCalls !== undefined) {
    return {
      role: "assistant",
      content: message.content === "" ? null : message.content,
      ...(message.reasoningContent === undefined
        ? {}
        : { reasoning_content: message.reasoningContent }),
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.argumentsJson },
      })),
    };
  }

  if (message.role === "tool") {
    return {
      role: "tool",
      content: message.content,
      ...(message.toolCallId === undefined ? {} : { tool_call_id: message.toolCallId }),
    };
  }

  return {
    role: message.role,
    content: message.content,
    ...(message.name === undefined ? {} : { name: message.name }),
    ...(message.toolCallId === undefined ? {} : { tool_call_id: message.toolCallId }),
  };
}

async function* readServerSentEvents(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onActivity: () => void,
  onChunk: (chunk: string) => void,
): AsyncGenerator<string, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const result = await readStreamChunk(reader, signal);
      if (result.done) {
        const tail = decoder.decode();
        if (tail !== "") onChunk(tail);
        buffer += tail;
        break;
      }
      onActivity();
      const chunk = decoder.decode(result.value, { stream: true });
      onChunk(chunk);
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("data:")) {
          yield line.slice(5).trimStart();
        }
      }
    }
    if (buffer.startsWith("data:")) {
      yield buffer.slice(5).trimStart();
    }
  } finally {
    reader.releaseLock();
  }
}

async function readStreamChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const abort = (): void => {
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    const result = await reader.read();
    signal.throwIfAborted();
    return result;
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
