import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, it } from "vitest";

import { DocumentWorkspace } from "./DocumentWorkspace.js";

describe("DocumentWorkspace", () => {
  it("shows multiple tabs and renders only the active document as plain text", () => {
    // Verify tab selection and literal text rendering without Markdown or HTML interpretation.
    // 1. Render two open tabs with the TXT document active.
    // 2. Confirm both tab labels and only the active content are present.
    // 3. Confirm Markdown-like and HTML-like text remains literal and inert.
    const html = renderToStaticMarkup(
      createElement(DocumentWorkspace, {
        tabs: [
          {
            relativePath: "manuscript/第一章.md",
            content: "不应显示的正文",
            error: null,
          },
          {
            relativePath: "manuscript/第二章.txt",
            content: "# 纯文本标题\n<script>危险内容</script>",
            error: null,
          },
        ],
        activePath: "manuscript/第二章.txt",
        runtimeInfo: null,
        onActivate: () => undefined,
      }),
    );

    expect(html).toContain("第一章.md");
    expect(html).toContain("第二章.txt");
    expect(html).toContain("# 纯文本标题\n");
    expect(html).toContain("&lt;script&gt;危险内容&lt;/script&gt;");
    expect(html).not.toContain("不应显示的正文");
    expect(html).not.toContain("<h1>");
  });
});
