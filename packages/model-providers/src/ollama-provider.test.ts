import { describe, expect, it } from "vitest";

import { OllamaProvider } from "./ollama-provider.js";

describe("OllamaProvider", () => {
  it("serializes assistant tool calls and names their tool results", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const provider = new OllamaProvider({
      baseUrl: "http://ollama.test",
      fetchImplementation: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response('{"message":{"content":"完成"},"done":true,"done_reason":"stop"}\n', {
          headers: { "Content-Type": "application/x-ndjson" },
        });
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
      },
      new AbortController().signal,
    )) {
      events.push(event);
    }

    expect(events).toContainEqual({ type: "text-delta", text: "完成" });

    expect(requestBody).toMatchObject({
      messages: [
        {
          role: "assistant",
          content: "",
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
  });
});
