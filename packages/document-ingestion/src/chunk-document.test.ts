import { describe, expect, it } from "vitest";

import { chunkDocument, parseDocument } from "./index.js";

describe("document chunking baseline", () => {
  it("greedily merges short TXT paragraphs into the previous chunk", () => {
    const sourceContent = "甲乙\n丙丁\n戊己";
    const result = chunk(sourceContent, "text", 8);

    expect(result.chunks.map((item) => item.content)).toEqual(["甲乙\n\n丙丁", "戊己"]);
    expect(result.chunks[0]).toMatchObject({
      ordinal: 0,
      characterCount: 6,
      startOffset: 0,
      endOffset: Buffer.byteLength("甲乙\n丙丁", "utf8"),
      blockTypes: ["p"],
    });
  });

  it("uses headings as merge boundaries and keeps a heading with following text", () => {
    const sourceContent = "前言\n\n# 标题\n\n正文";
    const result = chunk(sourceContent, "markdown", 50);

    expect(result.chunks.map((item) => item.content)).toEqual(["前言", "标题\n\n正文"]);
  });

  it("splits an oversized paragraph at a sentence ending inside the search window", () => {
    const sourceContent = "甲乙丙丁戊己庚辛。壬癸子丑寅卯辰巳";
    const result = chunk(sourceContent, "text", 12);

    expect(result.chunks.map((item) => item.content)).toEqual([
      "甲乙丙丁戊己庚辛。",
      "壬癸子丑寅卯辰巳",
    ]);
    expect(result.chunks.every((item) => item.characterCount <= 12)).toBe(true);
    expect(result.chunks[0]!.endOffset).toBe(Buffer.byteLength("甲乙丙丁戊己庚辛。", "utf8"));
    expect(result.chunks[1]!.startOffset).toBe(Buffer.byteLength("甲乙丙丁戊己庚辛。", "utf8"));
  });

  it("maps split Markdown text back through discarded inline style markers", () => {
    const sourceContent = "**甲乙**丙丁戊己庚辛。壬癸子丑寅卯辰巳";
    const result = chunk(sourceContent, "markdown", 12);

    expect(result.chunks.map((item) => item.content)).toEqual([
      "甲乙丙丁戊己庚辛。",
      "壬癸子丑寅卯辰巳",
    ]);
    expect(result.chunks[0]).toMatchObject({
      startOffset: Buffer.byteLength("**", "utf8"),
      endOffset: Buffer.byteLength("**甲乙**丙丁戊己庚辛。", "utf8"),
    });
    expect(result.chunks[1]!.startOffset).toBe(Buffer.byteLength("**甲乙**丙丁戊己庚辛。", "utf8"));
  });

  it("keeps a short list as one structural unit", () => {
    const sourceContent = "- 第一项\n- 第二项";
    const result = chunk(sourceContent, "markdown", 50);

    expect(result.chunks).toEqual([
      expect.objectContaining({
        content: "第一项\n第二项",
        blockTypes: ["ul"],
        startOffset: 0,
        endOffset: Buffer.byteLength(sourceContent, "utf8"),
      }),
    ]);
  });

  it("produces identical chunks when temporary CDM node IDs change", () => {
    const sourceContent = "# 标题\n\n第一段。\n\n第二段。";
    const first = chunkDocument(
      {
        parsedDocument: parseDocument({ format: "markdown", content: sourceContent }),
        sourceContent,
      },
      { maxChunkChars: 12, splitSearchWindowRatio: 0.75 },
    );
    const second = chunkDocument(
      {
        parsedDocument: parseDocument({ format: "markdown", content: sourceContent }),
        sourceContent,
      },
      { maxChunkChars: 12, splitSearchWindowRatio: 0.75 },
    );

    expect(first).toEqual(second);
  });
});

function chunk(sourceContent: string, format: "text" | "markdown", maxChunkChars: number) {
  return chunkDocument(
    { parsedDocument: parseDocument({ format, content: sourceContent }), sourceContent },
    { maxChunkChars, splitSearchWindowRatio: 0.75 },
  );
}
