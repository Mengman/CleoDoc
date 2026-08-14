import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, it } from "vitest";

import { ManuscriptList } from "./WorksSidebar.js";

describe("ManuscriptList", () => {
  it("shows Markdown and TXT paths relative to the manuscript directory", () => {
    // Verify the works sidebar displays the readable files in their supplied order.
    const html = renderToStaticMarkup(
      createElement(ManuscriptList, {
        documents: ["manuscript/第一卷/第一章.md", "manuscript/人物设定.txt"],
        activeDocumentPath: "manuscript/人物设定.txt",
        onOpenDocument: () => undefined,
      }),
    );

    expect(html).toContain("第一卷/第一章.md");
    expect(html).toContain("人物设定.txt");
    expect(html).not.toContain("manuscript/");
    expect(html.indexOf("第一卷/第一章.md")).toBeLessThan(html.indexOf("人物设定.txt"));
    expect(html).toContain('class="manuscript-list-item active"');
  });
});
