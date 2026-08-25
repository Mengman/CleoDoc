import { TextDecoder } from "node:util";

import { AppError } from "../../contracts/src/index.js";

export type MaterialInputEncoding = "utf-8" | "gb18030";

export interface DecodedMaterialText {
  readonly content: string;
  readonly inputEncoding: MaterialInputEncoding;
}

export function parseMaterialEncodingLabel(value: string): MaterialInputEncoding {
  const normalized = value.toLowerCase().replaceAll(/[\s_-]/g, "");
  if (normalized === "utf8") {
    return "utf-8";
  }
  if (normalized === "gb2312" || normalized === "gbk" || normalized === "gb18030") {
    return "gb18030";
  }
  throw new AppError("VALIDATION_ERROR", "--encoding 只能是 utf-8、gb2312、gbk 或 gb18030。");
}

export function decodeMaterialText(
  bytes: Uint8Array,
  requestedEncoding?: MaterialInputEncoding,
): DecodedMaterialText {
  // Decode a supported plain-text input while rejecting binary files before encoding fallback.
  // 1. Preserve the existing UTF-16 validation before treating NUL bytes as binary content.
  // 2. Reject binary control bytes that cannot belong to an imported plain-text document.
  // 3. Prefer UTF-8, then use GB18030 only when UTF-8 decoding fails.
  if (hasUtf16Bom(bytes)) {
    throw new AppError(
      "VALIDATION_ERROR",
      "资料使用 UTF-16 编码；当前只支持 UTF-8 和 GB2312/GBK/GB18030。",
    );
  }

  assertPlainTextBytes(bytes);

  if (requestedEncoding !== undefined) {
    return decodedResult(decodeOrThrow(bytes, requestedEncoding), requestedEncoding);
  }

  const utf8 = tryDecode(bytes, "utf-8");
  if (utf8 !== null) {
    return decodedResult(utf8, "utf-8");
  }

  const gb18030 = tryDecode(bytes, "gb18030");
  if (gb18030 !== null) {
    return decodedResult(gb18030, "gb18030");
  }

  throw unsupportedTextEncoding();
}

function decodedResult(content: string, inputEncoding: MaterialInputEncoding): DecodedMaterialText {
  // Reject decoded control characters that are unsuitable for plain-text material import.
  for (const character of content) {
    if (isUnexpectedControlCharacter(character)) {
      throw new AppError("VALIDATION_ERROR", "该文件不是文本文件，无法导入。");
    }
  }
  return { content, inputEncoding };
}

function assertPlainTextBytes(bytes: Uint8Array): void {
  // Reject binary control bytes before decoding can mistake an arbitrary file for text.
  for (const byte of bytes) {
    if (isUnexpectedControlByte(byte)) {
      throw new AppError("VALIDATION_ERROR", "该文件不是文本文件，无法导入。");
    }
  }
}

function isUnexpectedControlByte(byte: number): boolean {
  return (byte < 0x20 && !isTextWhitespace(byte)) || byte === 0x7f;
}

function isTextWhitespace(byte: number): boolean {
  return byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

function isUnexpectedControlCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0)!;
  return (
    ((codePoint >= 0 && codePoint < 0x20) || (codePoint >= 0x7f && codePoint <= 0x9f)) &&
    character !== "\t" &&
    character !== "\n" &&
    character !== "\r"
  );
}

function decodeOrThrow(bytes: Uint8Array, encoding: MaterialInputEncoding): string {
  const decoded = tryDecode(bytes, encoding);
  if (decoded === null) {
    throw new AppError("VALIDATION_ERROR", `资料内容不是有效的 ${encoding} 编码。`);
  }
  return decoded;
}

function tryDecode(bytes: Uint8Array, encoding: MaterialInputEncoding): string | null {
  // Decode bytes with a fatal decoder so invalid byte sequences cannot be silently replaced.
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(encoding, { fatal: true });
  } catch (error) {
    throw new AppError("CONFIG_ERROR", `当前运行环境不支持 ${encoding} 解码。`, {
      cause: error,
    });
  }
  try {
    return decoder.decode(bytes);
  } catch {
    return null;
  }
}

function hasUtf16Bom(bytes: Uint8Array): boolean {
  return (bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff);
}

function unsupportedTextEncoding(): AppError {
  return new AppError("VALIDATION_ERROR", "该文件不是文本文件，无法导入。");
}
