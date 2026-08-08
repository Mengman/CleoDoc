import { TextDecoder, TextEncoder } from "node:util";

import type { Position } from "unist";

import { DocumentIngestionError } from "./errors.js";
import type { SourceRange } from "./types.js";

export class Utf8Source {
  readonly text: string;
  readonly byteLength: number;
  private readonly byteOffsets: Uint32Array;

  private constructor(text: string, bytes: Uint8Array, bomLength: number) {
    this.text = text;
    this.byteLength = bytes.byteLength;
    this.byteOffsets = buildByteOffsets(text, bomLength);
    if (this.byteOffsets.at(-1) !== this.byteLength) {
      throw new DocumentIngestionError("INVALID_UTF8", "UTF-8 字节位置映射与原始资料长度不一致。");
    }
  }

  static from(content: string | Uint8Array): Utf8Source {
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      throw new DocumentIngestionError("INVALID_UTF8", "资料必须是有效的 UTF-8 文本。", error);
    }
    if (text.length === 0) {
      throw new DocumentIngestionError("EMPTY_DOCUMENT", "资料内容不能为空。");
    }
    return new Utf8Source(text, bytes, hasUtf8Bom(bytes) ? 3 : 0);
  }

  rangeFromPosition(position: Position | undefined): SourceRange {
    const start = position?.start.offset;
    const end = position?.end.offset;
    if (start === undefined || end === undefined) {
      throw new DocumentIngestionError(
        "INVALID_SOURCE_POSITION",
        "Markdown 解析结果缺少原文位置。",
      );
    }
    return this.rangeFromTextOffsets(start, end);
  }

  rangeFromTextOffsets(start: number, end: number): SourceRange {
    const startOffset = this.byteOffsets[start];
    const endOffset = this.byteOffsets[end];
    if (startOffset === undefined || endOffset === undefined || end < start) {
      throw new DocumentIngestionError("INVALID_SOURCE_POSITION", "解析结果包含无效的原文位置。");
    }
    return { startOffset, endOffset };
  }

  slice(position: Position | undefined): string {
    const start = position?.start.offset;
    const end = position?.end.offset;
    if (start === undefined || end === undefined || end < start) {
      throw new DocumentIngestionError(
        "INVALID_SOURCE_POSITION",
        "Markdown 解析结果缺少原文位置。",
      );
    }
    return this.text.slice(start, end);
  }
}

function buildByteOffsets(text: string, bomLength: number): Uint32Array {
  const offsets = new Uint32Array(text.length + 1);
  let byteOffset = bomLength;
  let textOffset = 0;
  offsets[0] = byteOffset;
  while (textOffset < text.length) {
    const codePoint = text.codePointAt(textOffset);
    if (codePoint === undefined) {
      break;
    }
    const width = codePoint > 0xffff ? 2 : 1;
    for (let index = 0; index < width; index += 1) {
      offsets[textOffset + index] = byteOffset;
    }
    byteOffset += utf8CodePointLength(codePoint);
    textOffset += width;
    offsets[textOffset] = byteOffset;
  }
  return offsets;
}

function utf8CodePointLength(codePoint: number): number {
  if (codePoint <= 0x7f) {
    return 1;
  }
  if (codePoint <= 0x7ff) {
    return 2;
  }
  if (codePoint <= 0xffff) {
    return 3;
  }
  return 4;
}

function hasUtf8Bom(bytes: Uint8Array): boolean {
  return bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
}
