import { DocumentIngestionError } from "./errors.js";
import type { SourceRange } from "./types.js";

export type TextSplitMode = "sentence" | "line" | "character";

export interface TextSlice {
  readonly content: string;
  readonly startCharacter: number;
  readonly endCharacter: number;
}

const STRONG_ENDINGS = new Set(["。", "！", "？", "!", "?"]);
const SECONDARY_ENDINGS = new Set(["；", ";", "，", ",", "：", ":"]);
const CLOSING_CHARACTERS = new Set([
  '"',
  "'",
  "”",
  "’",
  "」",
  "』",
  "）",
  ")",
  "】",
  "]",
  "〕",
  "〉",
  "》",
]);

export function countCharacters(content: string): number {
  return Array.from(content).length;
}

export function splitText(
  content: string,
  maxChunkChars: number,
  splitSearchWindowRatio: number,
  mode: TextSplitMode,
): TextSlice[] {
  const characters = Array.from(content);
  if (characters.length <= maxChunkChars) {
    return [{ content, startCharacter: 0, endCharacter: characters.length }];
  }

  const slices: TextSlice[] = [];
  let start = 0;
  while (characters.length - start > maxChunkChars) {
    const minimum = start + Math.max(1, Math.floor(maxChunkChars * splitSearchWindowRatio));
    const maximum = start + maxChunkChars;
    const end = chooseBoundary(characters, minimum, maximum, mode);
    slices.push({
      content: characters.slice(start, end).join(""),
      startCharacter: start,
      endCharacter: end,
    });
    start = end;
  }
  if (start < characters.length) {
    slices.push({
      content: characters.slice(start).join(""),
      startCharacter: start,
      endCharacter: characters.length,
    });
  }
  return slices;
}

export function locateTextSlices(
  sourceContent: string,
  visibleContent: string,
  sourceRange: SourceRange,
  slices: readonly TextSlice[],
): SourceRange[] {
  const sourceBytes = Buffer.from(sourceContent, "utf8");
  const raw = sourceBytes.subarray(sourceRange.startOffset, sourceRange.endOffset).toString("utf8");
  const visible = Array.from(visibleContent);
  const rawCharacters = readRawCharacters(raw, sourceRange.startOffset);
  const matched = new Array<number | undefined>(visible.length);
  let rawIndex = rawCharacters.length - 1;

  for (let visibleIndex = visible.length - 1; visibleIndex >= 0; visibleIndex -= 1) {
    let candidate = rawIndex;
    while (candidate >= 0 && rawCharacters[candidate]!.value !== visible[visibleIndex]) {
      candidate -= 1;
    }
    if (candidate < 0 && /\s/u.test(visible[visibleIndex] ?? "")) {
      continue;
    }
    if (candidate < 0) {
      throw new DocumentIngestionError(
        "INVALID_SOURCE_POSITION",
        "无法把切片文本准确定位回原始资料。",
      );
    }
    matched[visibleIndex] = candidate;
    rawIndex = candidate - 1;
  }

  return slices.map((slice) => {
    const firstRawIndex = findFirstMatched(matched, slice.startCharacter, slice.endCharacter);
    const lastRawIndex = findLastMatched(matched, slice.startCharacter, slice.endCharacter);
    if (firstRawIndex === undefined || lastRawIndex === undefined) {
      throw new DocumentIngestionError("INVALID_SOURCE_POSITION", "切片的原文位置无效。");
    }
    return {
      startOffset: rawCharacters[firstRawIndex]!.startOffset,
      endOffset: rawCharacters[lastRawIndex]!.endOffset,
    };
  });
}

function findFirstMatched(
  matched: readonly (number | undefined)[],
  start: number,
  end: number,
): number | undefined {
  for (let index = start; index < end; index += 1) {
    if (matched[index] !== undefined) {
      return matched[index];
    }
  }
  return undefined;
}

function findLastMatched(
  matched: readonly (number | undefined)[],
  start: number,
  end: number,
): number | undefined {
  for (let index = end - 1; index >= start; index -= 1) {
    if (matched[index] !== undefined) {
      return matched[index];
    }
  }
  return undefined;
}

function chooseBoundary(
  characters: readonly string[],
  minimum: number,
  maximum: number,
  mode: TextSplitMode,
): number {
  if (mode === "character") {
    return maximum;
  }
  if (mode === "line") {
    return findLatestBoundary(characters, minimum, maximum, (_, previous) => previous === "\n");
  }

  const strong = findLatestBoundary(characters, minimum, maximum, (next, previous, index) =>
    isStrongEnding(characters, next, previous, index),
  );
  if (
    strong !== maximum ||
    isStrongEnding(characters, characters[maximum], characters[maximum - 1], maximum)
  ) {
    return includeClosingCharacters(characters, strong, maximum);
  }
  const ellipsis = findLatestBoundary(characters, minimum, maximum, (_, __, index) =>
    endsWithEllipsis(characters, index),
  );
  if (ellipsis !== maximum || endsWithEllipsis(characters, maximum)) {
    return includeClosingCharacters(characters, ellipsis, maximum);
  }
  const secondary = findLatestBoundary(characters, minimum, maximum, (_, previous) =>
    SECONDARY_ENDINGS.has(previous ?? ""),
  );
  if (secondary !== maximum || SECONDARY_ENDINGS.has(characters[maximum - 1] ?? "")) {
    return secondary;
  }
  return findLatestBoundary(
    characters,
    minimum,
    maximum,
    (next, previous) => /\s/u.test(previous ?? "") || /\s/u.test(next ?? ""),
  );
}

function findLatestBoundary(
  characters: readonly string[],
  minimum: number,
  maximum: number,
  predicate: (next: string | undefined, previous: string | undefined, index: number) => boolean,
): number {
  for (let index = maximum; index >= minimum; index -= 1) {
    if (predicate(characters[index], characters[index - 1], index)) {
      return index;
    }
  }
  return maximum;
}

function isStrongEnding(
  characters: readonly string[],
  next: string | undefined,
  previous: string | undefined,
  index: number,
): boolean {
  if (STRONG_ENDINGS.has(previous ?? "")) {
    return true;
  }
  if (previous !== ".") {
    return false;
  }
  const before = characters[index - 2];
  if (isAsciiWord(before) && isAsciiWord(next)) {
    return false;
  }
  if (isCommonAbbreviation(characters, index)) {
    return false;
  }
  return (
    next === undefined || /\s/u.test(next) || CLOSING_CHARACTERS.has(next) || !isAsciiWord(next)
  );
}

function isAsciiWord(value: string | undefined): boolean {
  return value !== undefined && /[A-Za-z0-9]/u.test(value);
}

function isCommonAbbreviation(characters: readonly string[], index: number): boolean {
  const prefix = characters.slice(Math.max(0, index - 8), index).join("");
  return /(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|vs|etc|e\.g|i\.e)\.$/iu.test(prefix);
}

function endsWithEllipsis(characters: readonly string[], index: number): boolean {
  return (
    (characters[index - 1] === "…" && characters[index - 2] === "…") ||
    characters.slice(Math.max(0, index - 6), index).join("") === "......"
  );
}

function includeClosingCharacters(
  characters: readonly string[],
  boundary: number,
  maximum: number,
): number {
  let end = boundary;
  while (end < maximum && CLOSING_CHARACTERS.has(characters[end] ?? "")) {
    end += 1;
  }
  return end;
}

interface RawCharacter {
  readonly value: string;
  readonly startOffset: number;
  readonly endOffset: number;
}

function readRawCharacters(raw: string, absoluteStart: number): RawCharacter[] {
  const result: RawCharacter[] = [];
  let byteOffset = absoluteStart;
  for (const value of raw) {
    const byteLength = Buffer.byteLength(value, "utf8");
    result.push({ value, startOffset: byteOffset, endOffset: byteOffset + byteLength });
    byteOffset += byteLength;
  }
  return result;
}
