import { describe, expect, it } from "vitest";

import { decodeMaterialText, parseMaterialEncodingLabel } from "./text-decoding.js";

describe("material text encoding", () => {
  it("prefers valid UTF-8 and removes its BOM", () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("中文资料", "utf8")]);

    expect(decodeMaterialText(bytes)).toEqual({
      content: "中文资料",
      inputEncoding: "utf-8",
    });
  });

  it("falls back to GB18030 for GB2312-compatible bytes", () => {
    const bytes = Buffer.from("2320d6d0cec4d7cac1cf0a0abec9b3c7b3b5d5bea1a30a", "hex");

    expect(decodeMaterialText(bytes)).toEqual({
      content: "# 中文资料\n\n旧城车站。\n",
      inputEncoding: "gb18030",
    });
  });

  it("normalizes supported explicit encoding labels", () => {
    expect(parseMaterialEncodingLabel("UTF-8")).toBe("utf-8");
    expect(parseMaterialEncodingLabel("GB 2312")).toBe("gb18030");
    expect(parseMaterialEncodingLabel("gbk")).toBe("gb18030");
    expect(parseMaterialEncodingLabel("GB18030")).toBe("gb18030");
  });

  it("rejects UTF-16 and undecodable input", () => {
    expect(() => decodeMaterialText(Uint8Array.from([0xff, 0xfe, 0x41, 0x00]))).toThrow(
      expect.objectContaining({ code: "VALIDATION_ERROR" }),
    );
    expect(() => decodeMaterialText(Uint8Array.from([0x81]))).toThrow(
      expect.objectContaining({ code: "VALIDATION_ERROR" }),
    );
    expect(() => decodeMaterialText(Uint8Array.from([0x00, 0x01]))).toThrow(
      expect.objectContaining({ code: "VALIDATION_ERROR" }),
    );
  });
});
