import { describe, expect, it } from "vitest";

import { OpenAICompatibleProvider } from "./openai-compatible-provider.js";

describe("OpenAICompatibleProvider", () => {
  it("validates configuration and parses streamed text and usage", async () => {
    const fetchImplementation: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/models")) {
        return Response.json({ data: [{ id: "test-model" }] });
      }
      const body = [
        'data: {"choices":[{"delta":{"content":"你好"},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"delta":{"content":"，世界"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7}}\n\n',
        "data: [DONE]\n\n",
      ].join("");
      return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
    };
    const provider = new OpenAICompatibleProvider({
      baseUrl: "https://example.test/v1",
      fetchImplementation,
    });

    const health = await provider.validateConfiguration();
    expect(health.models).toEqual(["test-model"]);

    const events = [];
    for await (const event of provider.stream(
      { model: "test-model", messages: [{ role: "user", content: "问候" }] },
      new AbortController().signal,
    )) {
      events.push(event);
    }
    expect(
      events.filter((event) => event.type === "text-delta").map((event) => event.text),
    ).toEqual(["你好", "，世界"]);
    expect(events).toContainEqual({
      type: "usage",
      usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
    });
  });

  it("classifies authentication errors without exposing credentials", async () => {
    const provider = new OpenAICompatibleProvider({
      apiKey: "secret-value",
      baseUrl: "https://example.test/v1",
      fetchImplementation: async () => new Response("unauthorized", { status: 401 }),
    });

    await expect(provider.validateConfiguration()).rejects.toMatchObject({
      code: "PROVIDER_AUTH_ERROR",
    });
  });

  it("parses tool calls and serializes tool-call history for the next round", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const provider = new OpenAICompatibleProvider({
      baseUrl: "https://example.test/v1",
      fetchImplementation: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const body = [
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"write_project_","arguments":"{\\"path\\":\\"manuscript/summary.md\\","}}]}}]}\n\n',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"document","arguments":"\\"content\\":\\"总结\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
          "data: [DONE]\n\n",
        ].join("");
        return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
      },
    });

    const events = [];
    for await (const event of provider.stream(
      {
        model: "test-model",
        messages: [
          {
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: "prior-call",
                name: "list_project_documents",
                argumentsJson: "{}",
              },
            ],
          },
          { role: "tool", content: '{"ok":true}', toolCallId: "prior-call" },
        ],
      },
      new AbortController().signal,
    )) {
      events.push(event);
    }

    expect(events).toContainEqual({
      type: "tool-call",
      call: {
        id: "call-1",
        name: "write_project_document",
        argumentsJson: '{"path":"manuscript/summary.md","content":"总结"}',
      },
    });
    expect(requestBody).toMatchObject({
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "prior-call",
              type: "function",
              function: { name: "list_project_documents", arguments: "{}" },
            },
          ],
        },
        { role: "tool", content: '{"ok":true}', tool_call_id: "prior-call" },
      ],
    });
  });

  it("does not treat the connection timeout as a total streaming deadline", async () => {
    const provider = new OpenAICompatibleProvider({
      baseUrl: "https://example.test/v1",
      connectionTimeoutMs: 20,
      streamIdleTimeoutMs: 70,
      overallTimeoutMs: 300,
      fetchImplementation: async () =>
        new Response(
          timedStream([
            { afterMs: 0, text: 'data: {"choices":[{"delta":{"content":"第一段"}}]}\n\n' },
            { afterMs: 40, text: 'data: {"choices":[{"delta":{"content":"第二段"}}]}\n\n' },
            { afterMs: 80, text: "data: [DONE]\n\n", close: true },
          ]),
          { headers: { "Content-Type": "text/event-stream" } },
        ),
    });

    const events = await collectEvents(provider);
    expect(
      events.filter((event) => event.type === "text-delta").map((event) => event.text),
    ).toEqual(["第一段", "第二段"]);
  });

  it("distinguishes connection, stream-idle and overall generation timeouts", async () => {
    const connectionProvider = new OpenAICompatibleProvider({
      baseUrl: "https://example.test/v1",
      connectionTimeoutMs: 25,
      streamIdleTimeoutMs: 200,
      overallTimeoutMs: 300,
      fetchImplementation: async (_input, init) => await waitUntilAborted(init?.signal),
    });
    await expect(collectEvents(connectionProvider)).rejects.toMatchObject({
      code: "PROVIDER_TIMEOUT",
      details: { timeoutKind: "connection" },
    });

    const idleProvider = new OpenAICompatibleProvider({
      baseUrl: "https://example.test/v1",
      connectionTimeoutMs: 100,
      streamIdleTimeoutMs: 30,
      overallTimeoutMs: 300,
      fetchImplementation: async () =>
        new Response(
          timedStream([
            { afterMs: 0, text: 'data: {"choices":[{"delta":{"content":"开始"}}]}\n\n' },
          ]),
        ),
    });
    await expect(collectEvents(idleProvider)).rejects.toMatchObject({
      code: "PROVIDER_TIMEOUT",
      details: { timeoutKind: "stream_idle" },
    });

    const overallProvider = new OpenAICompatibleProvider({
      baseUrl: "https://example.test/v1",
      connectionTimeoutMs: 100,
      streamIdleTimeoutMs: 50,
      overallTimeoutMs: 80,
      fetchImplementation: async () => new Response(keepAliveStream(15)),
    });
    await expect(collectEvents(overallProvider)).rejects.toMatchObject({
      code: "PROVIDER_TIMEOUT",
      details: { timeoutKind: "overall" },
    });
  });
});

async function collectEvents(provider: OpenAICompatibleProvider) {
  const events = [];
  for await (const event of provider.stream(
    { model: "test-model", messages: [{ role: "user", content: "测试" }] },
    new AbortController().signal,
  )) {
    events.push(event);
  }
  return events;
}

function timedStream(
  chunks: readonly { afterMs: number; text: string; close?: boolean }[],
): ReadableStream<Uint8Array> {
  const timers: NodeJS.Timeout[] = [];
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        timers.push(
          setTimeout(() => {
            controller.enqueue(new TextEncoder().encode(chunk.text));
            if (chunk.close === true) {
              controller.close();
            }
          }, chunk.afterMs),
        );
      }
    },
    cancel() {
      timers.forEach(clearTimeout);
    },
  });
}

function keepAliveStream(intervalMs: number): ReadableStream<Uint8Array> {
  let timer: NodeJS.Timeout;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      timer = setInterval(
        () => controller.enqueue(new TextEncoder().encode(": keep-alive\n\n")),
        intervalMs,
      );
    },
    cancel() {
      clearInterval(timer);
    },
  });
}

async function waitUntilAborted(signal: AbortSignal | null | undefined): Promise<Response> {
  if (signal === null || signal === undefined) {
    return await new Promise<Response>(() => undefined);
  }
  return await new Promise<Response>((_resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}
