import { describe, expect, it } from "vitest";

import { parseDocument } from "./parse-document.js";
import { detectDocumentLanguages } from "./language-detection.js";

describe("detectDocumentLanguages", () => {
  it("orders Chinese and English by their dominant eligible block content", () => {
    const chinese =
      "这是用于验证资料语言判断的中文正文段落，包含足够多的汉字内容，并且会比英文段落拥有更多有效单位。".repeat(
        2,
      );
    const english = Array.from({ length: 70 }, (_, index) => `word${index}`).join(" ");
    const parsed = parseDocument({ format: "markdown", content: `${chinese}\n\n${english}` });

    expect(detectDocumentLanguages(parsed.cdm, { minBlockUnits: 50 })).toEqual(["zh", "en"]);
  });

  it("ignores headings, list items and code blocks even when they are long", () => {
    const englishWords = Array.from({ length: 80 }, (_, index) => `term${index}`).join(" ");
    const parsed = parseDocument({
      format: "markdown",
      content: `# ${englishWords}\n\n- ${englishWords}\n\n\`\`\`\n${englishWords}\n\`\`\``,
    });

    expect(detectDocumentLanguages(parsed.cdm, { minBlockUnits: 50 })).toEqual(["zh"]);
  });

  it("counts paragraphs inside blockquotes only once", () => {
    const chinese = "这是一段较长的中文资料内容，用于确保中文正文拥有七十个以上的有效字符。".repeat(
      3,
    );
    const english = Array.from({ length: 80 }, (_, index) => `evidence${index}`).join(" ");
    const quoted = english
      .split(" ")
      .map((word) => `> ${word}`)
      .join(" ");
    const parsed = parseDocument({ format: "markdown", content: `${chinese}\n\n> ${quoted}` });

    expect(detectDocumentLanguages(parsed.cdm, { minBlockUnits: 50 })).toEqual(["zh", "en"]);
  });

  it("ignores tied and short blocks and falls back to Chinese", () => {
    const parsed = parseDocument({ format: "text", content: "中文 English" });

    expect(detectDocumentLanguages(parsed.cdm, { minBlockUnits: 1 })).toEqual(["zh"]);
    expect(detectDocumentLanguages(parsed.cdm, { minBlockUnits: 50 })).toEqual(["zh"]);
  });
});
