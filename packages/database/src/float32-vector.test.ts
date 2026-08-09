import { describe, expect, it } from "vitest";

import { encodeFloat32LittleEndian } from "./float32-vector.js";

describe("Float32 vector encoding", () => {
  it("stores every value as IEEE 754 little-endian bytes", () => {
    const encoded = Buffer.from(encodeFloat32LittleEndian(Float32Array.from([1, -2.5, 0.25])));

    expect(encoded).toEqual(
      Buffer.from([0x00, 0x00, 0x80, 0x3f, 0x00, 0x00, 0x20, 0xc0, 0x00, 0x00, 0x80, 0x3e]),
    );
  });

  it("rejects empty and non-finite vectors", () => {
    expect(() => encodeFloat32LittleEndian(new Float32Array())).toThrow("不能为空");
    expect(() => encodeFloat32LittleEndian(Float32Array.from([Number.NaN]))).toThrow("无效数值");
  });
});
