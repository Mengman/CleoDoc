import { z } from "zod";

import type {
  ChatMessage,
  ModelEvent,
  ModelProvider,
  ModelRequest,
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

const tagsSchema = z
  .object({
    models: z.array(z.object({ name: z.string() }).passthrough()),
  })
  .passthrough();

const chatChunkSchema = z
  .object({
    message: z
      .object({
        content: z.string().default(""),
        thinking: z.string().optional(),
        tool_calls: z
          .array(
            z.object({
              function: z.object({
                name: z.string(),
                arguments: z.union([z.string(), z.record(z.string(), z.unknown())]),
              }),
            }),
          )
          .optional(),
      })
      .optional(),
    done: z.boolean().default(false),
    done_reason: z.string().optional(),
    prompt_eval_count: z.number().optional(),
    eval_count: z.number().optional(),
  })
  .passthrough();

export interface OllamaProviderOptions extends ProviderStreamTimeoutOptions {
  baseUrl: string;
  fetchImplementation?: typeof fetch;
}

export class OllamaProvider implements ModelProvider {
  readonly id = "ollama";
  readonly displayName = "Ollama";
  private readonly baseUrl: string;
  private readonly streamTimeouts: ProviderStreamTimeoutOptions;
  private readonly fetchImplementation: typeof fetch;

  constructor(options: OllamaProviderOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.streamTimeouts = {
      connectionTimeoutMs: options.connectionTimeoutMs,
      streamIdleTimeoutMs: options.streamIdleTimeoutMs,
      overallTimeoutMs: options.overallTimeoutMs,
    };
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  async validateConfiguration(callerSignal?: AbortSignal): Promise<ProviderHealth> {
    const requestSignal = withTimeout(
      callerSignal,
      Math.min(this.streamTimeouts.connectionTimeoutMs, 30_000),
    );
    try {
      const response = await this.fetchImplementation(`${this.baseUrl}/api/tags`, {
        signal: requestSignal,
      });
      if (!response.ok) {
        await throwForProviderResponse(response);
      }
      const parsed = tagsSchema.safeParse(await response.json());
      if (!parsed.success) {
        throw new AppError("PROVIDER_UNAVAILABLE", "Ollama 模型列表格式无效。");
      }
      return {
        ok: true,
        message: "连接成功。",
        models: parsed.data.models.map((model) => model.name),
      };
    } catch (error) {
      throw mapProviderFailure(error, callerSignal, requestSignal);
    }
  }

  async *stream(request: ModelRequest, callerSignal: AbortSignal): AsyncIterable<ModelEvent> {
    const timeouts = new ProviderStreamTimeoutController(callerSignal, this.streamTimeouts);
    const requestSignal = timeouts.signal;
    try {
      const url = `${this.baseUrl}/api/chat`;
      const headers = { Accept: "application/x-ndjson", "Content-Type": "application/json" };
      const body = JSON.stringify({
        model: request.model,
        messages: request.messages.map(toOllamaMessage),
        stream: true,
        options: {
          ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
          ...(request.maxTokens === undefined ? {} : { num_predict: request.maxTokens }),
        },
        ...(request.responseFormat?.type === "json_object" ? { format: "json" } : {}),
        ...(request.thinking === undefined ? {} : { think: request.thinking.type === "enabled" }),
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
        throw new AppError("PROVIDER_UNAVAILABLE", "Ollama 没有返回响应流。");
      }

      let toolIndex = 0;
      for await (const line of readLines(
        response.body,
        requestSignal,
        () => timeouts.markActivity(),
        (chunk) => emitProtocolEvent(request, { type: "response-chunk", chunk }),
      )) {
        if (line.trim() === "") {
          continue;
        }
        let parsedJson: unknown;
        try {
          parsedJson = JSON.parse(line) as unknown;
        } catch (error) {
          throw new AppError("PROVIDER_UNAVAILABLE", "Ollama 流式响应不是有效的 JSON。", {
            cause: error,
            details: {
              responseStage: "stream_json_parse",
              parserMessage: error instanceof Error ? error.message : String(error),
              dataPreview: line.slice(0, 500),
            },
          });
        }
        const parsed = chatChunkSchema.safeParse(parsedJson);
        if (!parsed.success) {
          throw new AppError("PROVIDER_UNAVAILABLE", "Ollama 流式响应格式无效。", {
            details: {
              responseStage: "stream_schema_validation",
              issues: parsed.error.issues,
              dataPreview: line.slice(0, 500),
            },
          });
        }
        if (parsed.data.message?.thinking) {
          yield { type: "reasoning-delta", text: parsed.data.message.thinking };
        }
        if (parsed.data.message?.content) {
          yield { type: "text-delta", text: parsed.data.message.content };
        }
        for (const toolCall of parsed.data.message?.tool_calls ?? []) {
          yield {
            type: "tool-call",
            call: {
              id: `ollama_tool_${toolIndex++}`,
              name: toolCall.function.name,
              argumentsJson:
                typeof toolCall.function.arguments === "string"
                  ? toolCall.function.arguments
                  : JSON.stringify(toolCall.function.arguments),
            },
          };
        }
        if (parsed.data.done) {
          if (parsed.data.prompt_eval_count !== undefined || parsed.data.eval_count !== undefined) {
            const inputTokens = parsed.data.prompt_eval_count;
            const outputTokens = parsed.data.eval_count;
            yield {
              type: "usage",
              usage: {
                inputTokens,
                outputTokens,
                totalTokens: (inputTokens ?? 0) + (outputTokens ?? 0),
              },
            };
          }
          yield {
            type: "done",
            ...(parsed.data.done_reason === undefined
              ? {}
              : { finishReason: parsed.data.done_reason }),
          };
        }
      }
    } catch (error) {
      throw mapProviderFailure(error, callerSignal, requestSignal, timeouts.timeoutKind);
    } finally {
      timeouts.dispose();
    }
  }
}

function toOllamaMessage(message: ChatMessage): Record<string, unknown> {
  if (message.role === "assistant" && message.toolCalls !== undefined) {
    return {
      role: "assistant",
      content: message.content,
      ...(message.reasoningContent === undefined ? {} : { thinking: message.reasoningContent }),
      tool_calls: message.toolCalls.map((call, index) => ({
        type: "function",
        function: {
          index,
          name: call.name,
          arguments: parseToolArguments(call.argumentsJson),
        },
      })),
    };
  }

  if (message.role === "tool") {
    return {
      role: "tool",
      content: message.content,
      ...(message.name === undefined ? {} : { tool_name: message.name }),
    };
  }

  return {
    role: message.role,
    content: message.content,
  };
}

function parseToolArguments(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

async function* readLines(
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
      yield* lines;
    }
    if (buffer !== "") {
      yield buffer;
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
