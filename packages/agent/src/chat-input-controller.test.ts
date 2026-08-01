import { describe, expect, it } from "vitest";

import { ChatInputController } from "./chat-input-controller.js";

describe("ChatInputController", () => {
  it("keeps an editable draft while submission is blocked and never auto-submits it", () => {
    const input = new ChatInputController();
    input.setSubmissionBlocked("正在压缩");
    input.captureDraft("压缩期间输入的内容");

    expect(input.editable).toBe(true);
    expect(input.submittable).toBe(false);
    expect(input.submit()).toBeNull();
    expect(input.draft).toBe("压缩期间输入的内容");

    input.allowSubmission();
    expect(input.draft).toBe("压缩期间输入的内容");
    expect(input.submit()).toBe("压缩期间输入的内容");
    expect(input.draft).toBe("");
  });
});
