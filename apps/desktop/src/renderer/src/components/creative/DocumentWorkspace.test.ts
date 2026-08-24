import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, it } from "vitest";

import { DocumentWorkspace } from "./DocumentWorkspace.js";

describe("DocumentWorkspace", () => {
  it("shows multiple tabs and renders only the active document as plain text", () => {
    // Verify tab selection and literal text rendering without Markdown or HTML interpretation.
    // 1. Render one manuscript and one material tab with the material active.
    // 2. Confirm both tab labels and only the active content are present.
    // 3. Confirm Markdown-like and HTML-like text remains literal and inert.
    const html = renderToStaticMarkup(
      createElement(DocumentWorkspace, {
        tabs: [
          {
            source: "manuscript",
            reference: "manuscript/第一章.md",
            content: "不应显示的正文",
            error: null,
          },
          {
            source: "material",
            reference: "港口资料",
            content: "# 纯文本标题\n<script>危险内容</script>",
            error: null,
          },
        ],
        activeTabKey: "material:港口资料",
        runtimeInfo: null,
        onActivate: () => undefined,
        onClose: () => undefined,
      }),
    );

    expect(html).toContain("第一章.md");
    expect(html).toContain("港口资料");
    expect(html).toContain('aria-label="关闭 第一章.md"');
    expect(html).toContain('aria-label="关闭 港口资料"');
    expect(html).toContain("# 纯文本标题\n");
    expect(html).toContain("&lt;script&gt;危险内容&lt;/script&gt;");
    expect(html).not.toContain("不应显示的正文");
    expect(html).not.toContain("<h1>");
  });
});
