import { describe, expect, it, vi } from "vitest";

import type { CleoDocDesktopApi, DesktopChatMessageEvent } from "../../shared/desktop-api.js";
import { DesktopChatClient } from "./desktop-chat-client.js";

describe("DesktopChatClient", () => {
  it("forwards only correlated events and disposes the temporary subscription", async () => {
    // Verify one renderer chat operation owns its stream correlation and listener lifetime.
    let listener: ((event: DesktopChatMessageEvent) => void) | undefined;
    const dispose = vi.fn();
    const sendChatMessage = vi.fn(async () => ({
      outcome: "success" as const,
      conversation: { id: conversationId, title: "测试对话" },
      messages: [],
    }));
    const api: Pick<CleoDocDesktopApi, "sendChatMessage" | "onChatMessageEvent"> = {
      sendChatMessage,
      onChatMessageEvent: (registered) => {
        listener = registered;
        return dispose;
      },
    };
    const events: DesktopChatMessageEvent[] = [];
    const client = new DesktopChatClient(api);

    const request = client.continueConversation(conversationId, "继续", (event) =>
      events.push(event),
    );
    listener?.({
      type: "content-delta",
      requestId: request.requestId,
      conversationId,
      text: "回答",
    });
    listener?.({
      type: "content-delta",
      requestId: "8e564f20-70ec-4a3d-b820-54299948635d",
      conversationId,
      text: "其他请求",
    });
    await request.result;

    expect(sendChatMessage).toHaveBeenCalledWith({
      requestId: request.requestId,
      conversationId,
      prompt: "继续",
    });
    expect(events).toEqual([expect.objectContaining({ type: "content-delta", text: "回答" })]);
    expect(dispose).toHaveBeenCalledOnce();
  });
});

const conversationId = "7e564f20-70ec-4a3d-b820-54299948635d";
