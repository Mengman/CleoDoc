import { describe, expect, it } from "vitest";

import {
  createOptimisticUserMessage,
  removeTemporaryMessages,
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
    expect(removeTemporaryMessages(content, "request")).toEqual([]);
  });

  it("expands active reasoning and collapses it when streaming completes", () => {
    // Verify streaming state overrides the ordinary user-controlled disclosure state.
    expect(resolveReasoningExpanded(true, false, false)).toBe(true);
    expect(resolveReasoningExpanded(false, true, true)).toBe(false);
    expect(resolveReasoningExpanded(false, false, true)).toBe(true);
  });
});
