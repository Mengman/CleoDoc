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
});
