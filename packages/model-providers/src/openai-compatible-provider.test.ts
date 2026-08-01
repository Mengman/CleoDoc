import { describe, expect, it } from "vitest";

import type { ModelProtocolEvent } from "../../contracts/src/index.js";
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
        'data: {"choices":[{"delta":{"content":"，世界"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7,"completion_tokens_details":{"reasoning_tokens":2}}}\n\n',
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
      usage: { inputTokens: 3, outputTokens: 4, reasoningTokens: 2, totalTokens: 7 },
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

  it("emits the raw request and streamed response while redacting credentials", async () => {
    const protocolEvents: ModelProtocolEvent[] = [];
    const provider = new OpenAICompatibleProvider({
      apiKey: "secret-value",
      baseUrl: "https://example.test/v1",
      fetchImplementation: async () =>
        new Response(
          'data: {"choices":[{"delta":{"content":"原始响应"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          {
            headers: {
              "Content-Type": "text/event-stream",
              "Set-Cookie": "session=secret-cookie",
              "X-Request-Id": "request-001",
            },
          },
        ),
    });

    const modelEvents = [];
    for await (const event of provider.stream(
      {
        model: "test-model",
        messages: [{ role: "user", content: "检查压缩格式" }],
        responseFormat: { type: "json_object" },
        thinking: { type: "disabled" },
        onProtocolEvent: (event) => protocolEvents.push(event),
      },
      new AbortController().signal,
    )) {
      modelEvents.push(event);
    }
    expect(modelEvents).toContainEqual({ type: "text-delta", text: "原始响应" });

    const requestEvent = protocolEvents.find((event) => event.type === "request");
    expect(requestEvent).toMatchObject({
      type: "request",
      method: "POST",
      url: "https://example.test/v1/chat/completions",
      headers: { Authorization: "<redacted>" },
    });
    expect(requestEvent?.type === "request" ? requestEvent.body : "").toContain("检查压缩格式");
    expect(
      requestEvent?.type === "request" ? JSON.parse(requestEvent.body) : undefined,
    ).toMatchObject({
      response_format: { type: "json_object" },
      thinking: { type: "disabled" },
    });
    expect(
      requestEvent?.type === "request" ? JSON.parse(requestEvent.body) : {},
    ).not.toHaveProperty("max_tokens");
    expect(JSON.stringify(protocolEvents)).not.toContain("secret-value");
    expect(JSON.stringify(protocolEvents)).not.toContain("secret-cookie");
    expect(protocolEvents).toContainEqual(
      expect.objectContaining({
        type: "response-head",
        status: 200,
        headers: expect.objectContaining({ "x-request-id": "request-001" }),
      }),
    );
    expect(
      protocolEvents
        .filter((event) => event.type === "response-chunk")
        .map((event) => event.chunk)
        .join(""),
    ).toContain('data: {"choices"');
  });

  it("reports JSON parsing details for an invalid streamed response", async () => {
    const provider = new OpenAICompatibleProvider({
      baseUrl: "https://example.test/v1",
      fetchImplementation: async () =>
        new Response("data: {not-json}\n\ndata: [DONE]\n\n", {
          headers: { "Content-Type": "text/event-stream" },
        }),
    });

    await expect(collectEvents(provider)).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      details: {
        responseStage: "stream_json_parse",
        dataPreview: "{not-json}",
      },
    });
  });

  it("reassembles JSON content deltas when SSE frames and network chunks are fragmented", async () => {
    const contentParts = ['{"schemaVersion":', "1,", '"handoffBrief":"完成"}'];
    const sse =
      contentParts
        .map(
          (content, index) =>
            `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: index === contentParts.length - 1 ? "stop" : null }] })}\n\n`,
        )
        .join("") + "data: [DONE]\n\n";
    const networkChunks = [sse.slice(0, 19), sse.slice(19, 71), sse.slice(71, 139), sse.slice(139)];
    const provider = new OpenAICompatibleProvider({
      baseUrl: "https://example.test/v1",
      fetchImplementation: async () => new Response(streamFromStrings(networkChunks)),
    });

    const events = await collectEvents(provider);
    const completeContent = events
      .filter((event) => event.type === "text-delta")
      .map((event) => event.text)
      .join("");
    expect(JSON.parse(completeContent)).toEqual({ schemaVersion: 1, handoffBrief: "完成" });
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
    expect(requestBody).not.toHaveProperty("response_format");
    expect(requestBody).not.toHaveProperty("thinking");
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

function streamFromStrings(chunks: readonly string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
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
