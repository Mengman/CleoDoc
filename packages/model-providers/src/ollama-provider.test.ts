import { describe, expect, it } from "vitest";

import type { ModelProtocolEvent } from "../../contracts/src/index.js";
import { OllamaProvider } from "./ollama-provider.js";

describe("OllamaProvider", () => {
  it("serializes assistant tool calls and names their tool results", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const protocolEvents: ModelProtocolEvent[] = [];
    const provider = new OllamaProvider({
      baseUrl: "http://ollama.test",
      fetchImplementation: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          '{"message":{"thinking":"先检查工具结果","content":"完成"},"done":true,"done_reason":"stop"}\n',
          {
            headers: { "Content-Type": "application/x-ndjson" },
          },
        );
      },
    });

    const events = [];
    for await (const event of provider.stream(
      {
        model: "qwen3",
        messages: [
          {
            role: "assistant",
            content: "",
            reasoningContent: "需要读取文档",
            toolCalls: [
              {
                id: "call-1",
                name: "read_project_document",
                argumentsJson: '{"document":"manuscript/notes.md"}',
              },
            ],
          },
          {
            role: "tool",
            name: "read_project_document",
            toolCallId: "call-1",
            content: '{"ok":true}',
          },
        ],
        responseFormat: { type: "json_object" },
        thinking: { type: "disabled" },
        onProtocolEvent: (event) => protocolEvents.push(event),
      },
      new AbortController().signal,
    )) {
      events.push(event);
    }

    expect(events).toContainEqual({ type: "text-delta", text: "完成" });
    expect(events).toContainEqual({ type: "reasoning-delta", text: "先检查工具结果" });

    expect(requestBody).toMatchObject({
      format: "json",
      think: false,
      messages: [
        {
          role: "assistant",
          content: "",
          thinking: "需要读取文档",
          tool_calls: [
            {
              type: "function",
              function: {
                index: 0,
                name: "read_project_document",
                arguments: { document: "manuscript/notes.md" },
              },
            },
          ],
        },
        {
          role: "tool",
          tool_name: "read_project_document",
          content: '{"ok":true}',
        },
      ],
    });
    expect(requestBody?.options).not.toHaveProperty("num_predict");
    expect(protocolEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "request", url: "http://ollama.test/api/chat" }),
        expect.objectContaining({ type: "response-head", status: 200 }),
        expect.objectContaining({
          type: "response-chunk",
          chunk:
            '{"message":{"thinking":"先检查工具结果","content":"完成"},"done":true,"done_reason":"stop"}\n',
        }),
      ]),
    );
  });
});
