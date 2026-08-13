import { describe, expect, it } from "vitest";

import {
  createOptimisticUserMessage,
  replaceTemporaryMessages,
  updateStreamingAssistantMessage,
} from "./ChatPanel.js";
import { resolveReasoningExpanded } from "./ConversationMessage.js";

describe("desktop chat stream state", () => {
  it("builds one assistant message from reasoning and content deltas", () => {
    // Verify reasoning and content remain separate while multiple deltas accumulate.
    const user = createOptimisticUserMessage("request", "继续写");
    const reasoning = updateStreamingAssistantMessage(
      [user],
      "streaming-request",
      "reasoning-delta",
      "先分析",
    );
    const content = updateStreamingAssistantMessage(
      reasoning,
      "streaming-request",
      "content-delta",
      "正文",
    );

    expect(content.at(-1)).toMatchObject({
      role: "assistant",
      reasoningContent: "先分析",
      content: "正文",
    });
    expect(
      replaceTemporaryMessages(content, "request", [
        { ...user, id: "7e564f20-70ec-4a3d-b820-54299948635d", sequence: 20 },
        {
          ...content.at(-1)!,
          id: "8e564f20-70ec-4a3d-b820-54299948635d",
          sequence: 21,
        },
      ]),
    ).toHaveLength(2);
  });

  it("preserves the initial page when a completed turn raises the list above twenty messages", () => {
    // Verify twenty is an initial load size rather than a maximum list length.
    const loaded = Array.from({ length: 20 }, (_, sequence) => ({
      id: `${String(sequence).padStart(8, "0")}-0000-4000-8000-000000000000`,
      role: "user" as const,
      content: `消息 ${sequence}`,
      sequence,
      createdAt: "2026-08-13T12:00:00.000Z",
    }));
    const temporary = [
      ...loaded,
      createOptimisticUserMessage("request", "继续写"),
      ...updateStreamingAssistantMessage([], "streaming-request", "content-delta", "回答"),
    ];
    const persisted = [
      { ...temporary.at(-2)!, id: "7e564f20-70ec-4a3d-b820-54299948635d", sequence: 20 },
      { ...temporary.at(-1)!, id: "8e564f20-70ec-4a3d-b820-54299948635d", sequence: 21 },
    ];

    expect(replaceTemporaryMessages(temporary, "request", persisted)).toHaveLength(22);
  });

  it("expands active reasoning and collapses it when streaming completes", () => {
    // Verify streaming state overrides the ordinary user-controlled disclosure state.
    expect(resolveReasoningExpanded(true, false, false)).toBe(true);
    expect(resolveReasoningExpanded(false, true, true)).toBe(false);
    expect(resolveReasoningExpanded(false, false, true)).toBe(true);
  });
});
