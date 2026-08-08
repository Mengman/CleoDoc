import { describe, expect, it } from "vitest";

import {
  assignMissingNodeIds,
  CDM_NODE_ID_ALPHABET,
  cdmDraftSchema,
  CdmError,
  findCdmElementById,
  generateCdmNodeId,
  getCdmTextContent,
  isCdmNodeId,
  parseCdmXml,
  serializeCdm,
  validateCdm,
  walkCdmElements,
} from "./index.js";
import type { CdmRandomBytes } from "./index.js";

const VALID_CHAPTER = `<document id="7k3m9qx2vc" version="1">
  <chapter id="b4r8t2w6yz" number="1">
    <h1 id="c5s9v3x7z0">第一章 雨夜</h1>
    <p id="d6t0w4y8a1">雨从凌晨开始下。</p>
    <p id="e7v1x5z9b2">林默站在<em>旧车站</em>外。</p>
  </chapter>
</document>`;

describe("CDM XML and draft schema", () => {
  it("parses and validates the confirmed chapter structure", () => {
    const document = parseCdmXml(VALID_CHAPTER);

    expect(validateCdm(document, cdmDraftSchema)).toEqual([]);
    expect(document.root.name).toBe("document");
    expect(getCdmTextContent(document)).toContain("林默站在旧车站外。");
  });

  it("rejects malformed XML, DTDs, XML comments and processing instructions", () => {
    for (const xml of [
      "<document>",
      '<!DOCTYPE document SYSTEM "example.dtd"><document/>',
      '<document id="7k3m9qx2vc" version="1"><!-- not CDM comment --></document>',
      "<?unsafe run?><document/>",
    ]) {
      expect(() => parseCdmXml(xml)).toThrow(CdmError);
    }
  });

  it("reports unknown tags, attributes and duplicate IDs", () => {
    const document = parseCdmXml(`<document id="7k3m9qx2vc" version="1">
      <p id="7k3m9qx2vc" onclick="run()">文本</p>
      <script id="b4r8t2w6yz">unsafe</script>
    </document>`);

    expect(validateCdm(document, cdmDraftSchema).map((issue) => issue.code)).toEqual([
      "UNKNOWN_ATTRIBUTE",
      "DUPLICATE_NODE_ID",
      "UNKNOWN_TAG",
    ]);
  });

  it("does not allow an addressable Node inside a Mark", () => {
    const document = parseCdmXml(`<document id="7k3m9qx2vc" version="1">
      <p id="b4r8t2w6yz"><strong><p id="c5s9v3x7z0">错误嵌套</p></strong></p>
    </document>`);

    expect(validateCdm(document, cdmDraftSchema)).toContainEqual(
      expect.objectContaining({ code: "INVALID_PARENT" }),
    );
  });

  it("maps the HTML mark tag to the inline style definition", () => {
    const document = parseCdmXml(`<document id="7k3m9qx2vc" version="1">
      <p id="b4r8t2w6yz">普通文字<mark>重点文字</mark></p>
    </document>`);

    expect(cdmDraftSchema.tags.mark?.kind).toBe("mark");
    expect(validateCdm(document, cdmDraftSchema)).toEqual([]);
  });
});

describe("CDM Node IDs", () => {
  it("uses the confirmed ten-character Crockford Base32 alphabet", () => {
    const id = generateCdmNodeId(new Set(), () =>
      Uint8Array.from([0, 1, 8, 9, 16, 17, 24, 25, 30, 31]),
    );

    expect(id).toBe("0189ghrsyz");
    expect(isCdmNodeId(id)).toBe(true);
    expect(isCdmNodeId("contains-i")).toBe(false);
  });

  it("retries a collision and assigns IDs without mutating the input tree", () => {
    const original = parseCdmXml(
      `<document version="1"><article><p>正文<strong>重点</strong></p></article></document>`,
    );
    const collision = bytesForId("7k3m9qx2vc");
    const generated = [
      collision,
      collision,
      bytesForId("b4r8t2w6yz"),
      bytesForId("c5s9v3x7z0"),
      bytesForId("d6t0w4y8a1"),
    ];
    let index = 0;
    const randomSource: CdmRandomBytes = () => generated[index++] ?? new Uint8Array(10);

    const withIds = assignMissingNodeIds(original, cdmDraftSchema, randomSource);
    const ids = [...walkCdmElements(withIds)]
      .map((element) => element.attributes.id)
      .filter((id): id is string => id !== undefined);

    expect(original.root.attributes.id).toBeUndefined();
    expect(ids).toEqual(["7k3m9qx2vc", "b4r8t2w6yz", "c5s9v3x7z0"]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(withIds.root.children[0]).toMatchObject({
      type: "element",
      children: expect.arrayContaining([
        expect.objectContaining({
          name: "p",
          children: expect.arrayContaining([
            expect.objectContaining({ name: "strong", attributes: {} }),
          ]),
        }),
      ]),
    });
  });

  it("fails after ten collisions", () => {
    const collision = "7k3m9qx2vc";
    expect(() => generateCdmNodeId(new Set([collision]), () => bytesForId(collision))).toThrow(
      expect.objectContaining({ code: "CDM_ID_GENERATION_FAILED" }),
    );
  });
});

describe("CDM serialization and traversal", () => {
  it("serializes attributes deterministically and escapes XML text", () => {
    const document = parseCdmXml(
      '<document version="1" id="7k3m9qx2vc"><p id="b4r8t2w6yz">A &amp; B &lt; C</p></document>',
    );

    const serialized = serializeCdm(document, cdmDraftSchema);

    expect(serialized).toBe(
      '<document id="7k3m9qx2vc" version="1"><p id="b4r8t2w6yz">A &amp; B &lt; C</p></document>',
    );
    expect(validateCdm(parseCdmXml(serialized), cdmDraftSchema)).toEqual([]);
  });

  it("finds elements by their public Node ID", () => {
    const document = parseCdmXml(VALID_CHAPTER);

    expect(findCdmElementById(document, "d6t0w4y8a1")?.name).toBe("p");
    expect(findCdmElementById(document, "0000000000")).toBeUndefined();
  });
});

function bytesForId(id: string): Uint8Array {
  return Uint8Array.from([...id].map((character) => CDM_NODE_ID_ALPHABET.indexOf(character)));
}
