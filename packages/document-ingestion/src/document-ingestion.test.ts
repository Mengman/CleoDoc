import { describe, expect, it } from "vitest";

import { cdmDraftSchema, getCdmTextContent, validateCdm, walkCdmElements } from "@cleodoc/cdm";
import type { CdmDocument, CdmRandomBytes } from "@cleodoc/cdm";

import { DocumentIngestionError, parseDocument } from "./index.js";

describe("TXT document ingestion", () => {
  it("parses paragraphs, preserves single line breaks and records UTF-8 byte ranges", () => {
    const text = "第一段第一行\r\n第二行\r\n \t\r\n第二段🙂";
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, "utf8")]);
    const result = parseDocument(
      { format: "text", content: bytes },
      { randomSource: createRandomSource(0) },
    );
    const paragraphs = elementsNamed(result.cdm, "p");

    expect(result.status).toBe("ok");
    expect(result.sourceByteLength).toBe(bytes.byteLength);
    expect(paragraphs.map(getCdmTextContent)).toEqual(["第一段第一行\n第二行", "第二段🙂"]);
    expect(rangeFor(result, paragraphs[0]!.attributes.id!)).toEqual({
      startOffset: 3,
      endOffset: 3 + Buffer.byteLength("第一段第一行\r\n第二行", "utf8"),
    });
    expect(rangeFor(result, paragraphs[1]!.attributes.id!)).toEqual({
      startOffset: bytes.indexOf(Buffer.from("第二段", "utf8")),
      endOffset: bytes.byteLength,
    });
    expect(validateCdm(result.cdm, cdmDraftSchema)).toEqual([]);
  });

  it("marks whitespace-only material as having no visible content", () => {
    const result = parseDocument(
      { format: "text", content: " \t\r\n\r\n" },
      { randomSource: createRandomSource(1) },
    );

    expect(result.status).toBe("partial");
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "NO_VISIBLE_CONTENT" }));
    expect(elementsNamed(result.cdm, "p")).toEqual([]);
  });

  it("rejects invalid UTF-8 without producing a partial document", () => {
    expect(() => parseDocument({ format: "text", content: Uint8Array.from([0xc3, 0x28]) })).toThrow(
      expect.objectContaining({ code: "INVALID_UTF8" }),
    );
  });
});

describe("Markdown document ingestion", () => {
  it("maps document structure, drops pure styles and supports GFM tables", () => {
    const markdown = `# 标题

这是 **加粗**、*斜体*、[链接](https://example.com "示例") 和 \`inline\`。

> 引用段落

3. 第三项
4. 第四项

- parent
  - child

~~~ts metadata
const value = 1;
~~~

| 名称 | 值 |
| --- | --- |
| 温度 | 20 |
`;
    const result = parseDocument(
      { format: "markdown", content: markdown },
      { randomSource: createRandomSource(2) },
    );
    const names = [...walkCdmElements(result.cdm)].map((element) => element.name);
    const paragraph = elementsNamed(result.cdm, "p")[0]!;
    const orderedList = elementsNamed(result.cdm, "ol")[0]!;
    const link = elementsNamed(result.cdm, "a")[0]!;

    expect(names).toEqual(
      expect.arrayContaining([
        "h1",
        "p",
        "a",
        "code",
        "blockquote",
        "ol",
        "li",
        "pre",
        "table",
        "tr",
        "th",
        "td",
      ]),
    );
    expect(names).not.toContain("strong");
    expect(names).not.toContain("em");
    expect(getCdmTextContent(paragraph)).toBe("这是 加粗、斜体、链接 和 inline。");
    expect(orderedList.attributes.start).toBe("3");
    expect(elementsNamed(result.cdm, "ul")).toHaveLength(2);
    expect(link.attributes).toMatchObject({ href: "https://example.com", title: "示例" });
    const addressableIds = [...walkCdmElements(result.cdm)]
      .filter((element) => cdmDraftSchema.tags[element.name]?.kind === "node")
      .map((element) => element.attributes.id);
    expect(new Set(result.nodeRanges.map((range) => range.nodeId))).toEqual(
      new Set(addressableIds),
    );
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: "CODE_METADATA_DROPPED" }),
    );
    expect(validateCdm(result.cdm, cdmDraftSchema)).toEqual([]);
  });

  it("preserves raw HTML as escaped text and reduces images to alt text", () => {
    const markdown = `<script>alert("x")</script>

![架构图](diagram.png)
`;
    const result = parseDocument(
      { format: "markdown", content: markdown },
      { randomSource: createRandomSource(3) },
    );

    expect(result.status).toBe("partial");
    expect(result.cdmXml).not.toContain("<script>");
    expect(result.cdmXml).toContain("&lt;script&gt;");
    expect(getCdmTextContent(result.cdm)).toContain('alert("x")');
    expect(getCdmTextContent(result.cdm)).toContain("架构图");
    expect(result.warnings.map((warning) => warning.code)).toEqual([
      "RAW_HTML_PRESERVED_AS_TEXT",
      "IMAGE_REDUCED_TO_ALT_TEXT",
    ]);
  });

  it("resolves reference links without emitting definition text", () => {
    const markdown = `[官方文档][docs]

[docs]: https://example.com/docs "Docs"
`;
    const result = parseDocument(
      { format: "markdown", content: markdown },
      { randomSource: createRandomSource(4) },
    );
    const link = elementsNamed(result.cdm, "a")[0]!;

    expect(link.attributes).toMatchObject({ href: "https://example.com/docs", title: "Docs" });
    expect(getCdmTextContent(result.cdm)).toBe("官方文档");
    expect(result.warnings).toEqual([]);
  });

  it("keeps structure and ranges deterministic while temporary Node IDs remain random", () => {
    const markdown = "## 中文标题\n\n段落🙂。\n";
    const first = parseDocument(
      { format: "markdown", content: markdown },
      { randomSource: createRandomSource(5) },
    );
    const second = parseDocument(
      { format: "markdown", content: markdown },
      { randomSource: createRandomSource(19) },
    );

    expect(withoutNodeIds(first.cdm)).toEqual(withoutNodeIds(second.cdm));
    expect(first.nodeRanges.map(withoutRangeId)).toEqual(second.nodeRanges.map(withoutRangeId));
    expect(first.cdm.root.attributes.id).not.toBe(second.cdm.root.attributes.id);

    const heading = elementsNamed(first.cdm, "h2")[0]!;
    expect(rangeFor(first, heading.attributes.id!)).toEqual({
      startOffset: 0,
      endOffset: Buffer.byteLength("## 中文标题", "utf8"),
    });
    const paragraph = elementsNamed(first.cdm, "p")[0]!;
    const paragraphStart = Buffer.byteLength("## 中文标题\n\n", "utf8");
    expect(rangeFor(first, paragraph.attributes.id!)).toEqual({
      startOffset: paragraphStart,
      endOffset: paragraphStart + Buffer.byteLength("段落🙂。", "utf8"),
    });
  });
});

function elementsNamed(document: CdmDocument, name: string) {
  return [...walkCdmElements(document)].filter((element) => element.name === name);
}

function rangeFor(
  result: ReturnType<typeof parseDocument>,
  nodeId: string,
): { startOffset: number; endOffset: number } | undefined {
  const range = result.nodeRanges.find((candidate) => candidate.nodeId === nodeId);
  return range === undefined
    ? undefined
    : { startOffset: range.startOffset, endOffset: range.endOffset };
}

function withoutNodeIds(document: CdmDocument): unknown {
  return JSON.parse(JSON.stringify(document), (key, value: unknown) => {
    if (key === "id") {
      return undefined;
    }
    return value;
  }) as unknown;
}

function withoutRangeId(range: { startOffset: number; endOffset: number }) {
  return { startOffset: range.startOffset, endOffset: range.endOffset };
}

function createRandomSource(seed: number): CdmRandomBytes {
  let call = seed;
  return (size) => {
    const bytes = Uint8Array.from({ length: size }, (_, index) => (call + index) & 31);
    call += 1;
    return bytes;
  };
}

it("uses stable domain errors", () => {
  expect(() => parseDocument({ format: "text", content: "" })).toThrow(DocumentIngestionError);
});
