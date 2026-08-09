import type { CdmChild, CdmElement } from "@cleodoc/cdm";

import { DocumentIngestionError } from "./errors.js";
import { countCharacters, locateTextSlices, splitText } from "./chunk-text.js";
import type {
  ChunkDocumentInput,
  ChunkDocumentOptions,
  ChunkDraft,
  ChunkedDocument,
} from "./chunk-types.js";
import type { SourceRange } from "./types.js";

export const DOCUMENT_CHUNKER_VERSION = "structural-baseline-v1";

interface Fragment extends SourceRange {
  readonly content: string;
  readonly blockTypes: readonly string[];
  readonly section: number;
}

export function chunkDocument(
  input: ChunkDocumentInput,
  options: ChunkDocumentOptions,
): ChunkedDocument {
  assertOptions(options);
  if (Buffer.byteLength(input.sourceContent, "utf8") !== input.parsedDocument.sourceByteLength) {
    throw new DocumentIngestionError(
      "INVALID_SOURCE_POSITION",
      "用于切片的原始资料与解析结果长度不一致。",
    );
  }

  const ranges = new Map(
    input.parsedDocument.nodeRanges.map((range) => [range.nodeId, range] as const),
  );
  const article = input.parsedDocument.cdm.root.children.find(
    (child): child is CdmElement => child.type === "element" && child.name === "article",
  );
  if (article === undefined) {
    throw new DocumentIngestionError("INVALID_SOURCE_POSITION", "CDM 文档缺少 article 节点。");
  }

  const fragments: Fragment[] = [];
  let section = 0;
  let previousWasHeading = false;
  for (const child of article.children) {
    if (child.type !== "element") {
      continue;
    }
    const heading = isHeading(child.name);
    if (heading && !previousWasHeading) {
      section += 1;
    }
    fragments.push(...splitElement(child, section, input.sourceContent, ranges, options));
    previousWasHeading = heading;
    if (!heading) {
      previousWasHeading = false;
    }
  }

  const chunks = mergeFragments(fragments, options.maxChunkChars);
  return {
    chunkerVersion: DOCUMENT_CHUNKER_VERSION,
    parserVersion: input.parsedDocument.parserVersion,
    sourceByteLength: input.parsedDocument.sourceByteLength,
    config: { ...options },
    chunks,
  };
}

function splitElement(
  element: CdmElement,
  section: number,
  sourceContent: string,
  ranges: ReadonlyMap<string, SourceRange>,
  options: ChunkDocumentOptions,
): Fragment[] {
  const whole = createFragment(element, section, ranges);
  if (countCharacters(whole.content) <= options.maxChunkChars) {
    return whole.content === "" ? [] : [whole];
  }

  if (element.name === "ol" || element.name === "ul") {
    return splitChildren(element, ["li"], section, sourceContent, ranges, options);
  }
  if (element.name === "blockquote") {
    return splitChildren(element, undefined, section, sourceContent, ranges, options);
  }
  if (element.name === "table") {
    return splitChildren(element, ["tr"], section, sourceContent, ranges, options);
  }
  const mode = element.name === "pre" ? "line" : isHeading(element.name) ? "character" : "sentence";
  return splitFragment(whole, sourceContent, options, mode);
}

function splitChildren(
  parent: CdmElement,
  allowedNames: readonly string[] | undefined,
  section: number,
  sourceContent: string,
  ranges: ReadonlyMap<string, SourceRange>,
  options: ChunkDocumentOptions,
): Fragment[] {
  const children = parent.children.filter(
    (child): child is CdmElement =>
      child.type === "element" && (allowedNames === undefined || allowedNames.includes(child.name)),
  );
  const result: Fragment[] = [];
  for (const child of children) {
    const fragment = createFragment(child, section, ranges, parent.name);
    if (fragment.content === "") {
      continue;
    }
    if (countCharacters(fragment.content) <= options.maxChunkChars) {
      result.push(fragment);
      continue;
    }
    if (parent.name === "table" && child.name === "tr") {
      const cells = splitChildren(child, ["th", "td"], section, sourceContent, ranges, options);
      result.push(...cells);
      continue;
    }
    result.push(
      ...splitFragment(
        fragment,
        sourceContent,
        options,
        parent.name === "pre" ? "line" : "sentence",
      ),
    );
  }
  return result;
}

function splitFragment(
  fragment: Fragment,
  sourceContent: string,
  options: ChunkDocumentOptions,
  mode: "sentence" | "line" | "character",
): Fragment[] {
  const slices = splitText(
    fragment.content,
    options.maxChunkChars,
    options.splitSearchWindowRatio,
    mode,
  );
  const ranges = locateTextSlices(sourceContent, fragment.content, fragment, slices);
  return slices.map((slice, index) => ({
    content: slice.content,
    startOffset: ranges[index]!.startOffset,
    endOffset: ranges[index]!.endOffset,
    blockTypes: fragment.blockTypes,
    section: fragment.section,
  }));
}

function mergeFragments(fragments: readonly Fragment[], maxChunkChars: number): ChunkDraft[] {
  const merged: Fragment[] = [];
  for (const fragment of fragments) {
    const previous = merged.at(-1);
    if (
      previous !== undefined &&
      previous.section === fragment.section &&
      countCharacters(`${previous.content}\n\n${fragment.content}`) <= maxChunkChars
    ) {
      merged[merged.length - 1] = {
        content: `${previous.content}\n\n${fragment.content}`,
        startOffset: previous.startOffset,
        endOffset: fragment.endOffset,
        blockTypes: [...new Set([...previous.blockTypes, ...fragment.blockTypes])],
        section: previous.section,
      };
    } else {
      merged.push(fragment);
    }
  }
  return merged.map((fragment, ordinal) => ({
    ordinal,
    content: fragment.content,
    characterCount: countCharacters(fragment.content),
    startOffset: fragment.startOffset,
    endOffset: fragment.endOffset,
    blockTypes: fragment.blockTypes,
  }));
}

function createFragment(
  element: CdmElement,
  section: number,
  ranges: ReadonlyMap<string, SourceRange>,
  parentType?: string,
): Fragment {
  const id = element.attributes.id;
  const range = id === undefined ? undefined : ranges.get(id);
  if (range === undefined) {
    throw new DocumentIngestionError(
      "INVALID_SOURCE_POSITION",
      `CDM 节点 ${element.name} 缺少原文位置。`,
    );
  }
  return {
    content: renderElement(element),
    startOffset: range.startOffset,
    endOffset: range.endOffset,
    blockTypes: parentType === undefined ? [element.name] : [parentType, element.name],
    section,
  };
}

function renderElement(element: CdmElement): string {
  if (element.name === "ol" || element.name === "ul") {
    return childElements(element, "li").map(renderElement).join("\n");
  }
  if (element.name === "li" || element.name === "blockquote") {
    return renderChildren(element.children, "\n\n");
  }
  if (element.name === "table") {
    return childElements(element, "tr").map(renderElement).join("\n");
  }
  if (element.name === "tr") {
    return element.children
      .filter(
        (child): child is CdmElement =>
          child.type === "element" && (child.name === "th" || child.name === "td"),
      )
      .map(renderElement)
      .join("\t");
  }
  return renderChildren(element.children, "");
}

function renderChildren(children: readonly CdmChild[], blockSeparator: string): string {
  return children
    .map((child) => (child.type === "text" ? child.value : renderElement(child)))
    .filter((value) => value !== "")
    .join(blockSeparator);
}

function childElements(element: CdmElement, name: string): CdmElement[] {
  return element.children.filter(
    (child): child is CdmElement => child.type === "element" && child.name === name,
  );
}

function isHeading(name: string): boolean {
  return /^h[1-6]$/u.test(name);
}

function assertOptions(options: ChunkDocumentOptions): void {
  if (
    !Number.isInteger(options.maxChunkChars) ||
    options.maxChunkChars < 1 ||
    !Number.isFinite(options.splitSearchWindowRatio) ||
    options.splitSearchWindowRatio <= 0 ||
    options.splitSearchWindowRatio > 1
  ) {
    throw new DocumentIngestionError("INVALID_CHUNK_OPTIONS", "资料切片参数无效。");
  }
}
