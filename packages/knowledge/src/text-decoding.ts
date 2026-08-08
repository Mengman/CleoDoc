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
  if (requestedEncoding !== undefined) {
    return decodedResult(decodeOrThrow(bytes, requestedEncoding), requestedEncoding);
  }

  if (hasUtf16Bom(bytes)) {
    throw new AppError(
      "VALIDATION_ERROR",
      "资料使用 UTF-16 编码；当前只支持 UTF-8 和 GB2312/GBK/GB18030。",
    );
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
  for (const character of content) {
    if (isUnexpectedControlCharacter(character)) {
      throw new AppError("VALIDATION_ERROR", "资料包含不适用于文本导入的控制字符。");
    }
  }
  return { content, inputEncoding };
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
  return new AppError(
    "VALIDATION_ERROR",
    "无法识别资料编码；请使用 --encoding utf-8、gb2312、gbk 或 gb18030 明确指定。",
  );
}
