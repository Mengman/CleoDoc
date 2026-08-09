import { AppError } from "../../contracts/src/index.js";

export function assertFloat32Vector(vector: Float32Array): void {
  if (vector.length === 0) {
    throw new AppError("VALIDATION_ERROR", "Embedding 向量不能为空。");
  }
  for (const value of vector) {
    if (!Number.isFinite(value)) {
      throw new AppError("VALIDATION_ERROR", "Embedding 向量包含无效数值。");
    }
  }
}

export function encodeFloat32LittleEndian(vector: Float32Array): Uint8Array {
  assertFloat32Vector(vector);
  const bytes = Buffer.allocUnsafe(vector.length * 4);
  for (let index = 0; index < vector.length; index += 1) {
    bytes.writeFloatLE(vector[index]!, index * 4);
  }
  return bytes;
}
