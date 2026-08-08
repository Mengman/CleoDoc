import { assertValidCdm, cdmDraftSchema, generateCdmNodeId, serializeCdm } from "@cleodoc/cdm";
import type { CdmChild, CdmDocument, CdmElement, CdmRandomBytes, CdmText } from "@cleodoc/cdm";

import type { CdmNodeSourceRange, SourceRange } from "./types.js";

export class IngestionCdmBuilder {
  private readonly ids = new Set<string>();
  private readonly ranges: CdmNodeSourceRange[] = [];

  constructor(private readonly randomSource?: CdmRandomBytes) {}

  text(value: string): CdmText {
    return { type: "text", value };
  }

  node(
    name: string,
    children: readonly CdmChild[],
    range: SourceRange,
    attributes: Readonly<Record<string, string>> = {},
  ): CdmElement {
    const id = generateCdmNodeId(this.ids, this.randomSource);
    this.ids.add(id);
    this.ranges.push({ nodeId: id, ...range });
    return {
      type: "element",
      name,
      attributes: { id, ...attributes },
      children: [...children],
    };
  }

  finish(
    children: readonly CdmChild[],
    sourceByteLength: number,
  ): {
    cdm: CdmDocument;
    cdmXml: string;
    nodeRanges: readonly CdmNodeSourceRange[];
  } {
    const fullRange = { startOffset: 0, endOffset: sourceByteLength };
    const article = this.node("article", children, fullRange);
    const root = this.node("document", [article], fullRange, { version: "1" });
    const cdm = { root };
    assertValidCdm(cdm, cdmDraftSchema);
    return {
      cdm,
      cdmXml: serializeCdm(cdm, cdmDraftSchema),
      nodeRanges: [...this.ranges],
    };
  }
}
