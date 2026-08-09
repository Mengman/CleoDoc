import { describe, expect, it } from "vitest";

import { resolveEmbeddingLlamaBackend } from "./embedding-platform.js";

describe("resolveEmbeddingLlamaBackend", () => {
  it("uses the available Metal prebuilt binding on Apple Silicon", () => {
    expect(resolveEmbeddingLlamaBackend("darwin", "arm64")).toBe("metal");
  });

  it.each([
    ["darwin", "x64"],
    ["linux", "x64"],
    ["win32", "x64"],
  ] as const)("keeps the CPU binding on %s %s", (platform, architecture) => {
    expect(resolveEmbeddingLlamaBackend(platform, architecture)).toBe(false);
  });
});
