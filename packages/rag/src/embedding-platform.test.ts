import { describe, expect, it } from "vitest";

import { resolveEmbeddingLlamaOptions } from "./embedding-platform.js";

describe("resolveEmbeddingLlamaOptions", () => {
  it.each([
    ["darwin", "arm64"],
    ["darwin", "x64"],
    ["linux", "x64"],
    ["win32", "x64"],
  ] as const)(
    "uses llama.cpp auto GPU settings on %s %s when enabled",
    (platform, architecture) => {
      expect(resolveEmbeddingLlamaOptions(true, platform, architecture)).toEqual({
        gpu: "auto",
        gpuLayers: "auto",
      });
    },
  );

  it("uses the Metal prebuilt binding without layer offload on Apple Silicon when disabled", () => {
    expect(resolveEmbeddingLlamaOptions(false, "darwin", "arm64")).toEqual({
      gpu: "metal",
      gpuLayers: 0,
    });
  });

  it.each([
    ["darwin", "x64"],
    ["linux", "x64"],
    ["win32", "x64"],
  ] as const)("keeps CPU-only settings on %s %s when disabled", (platform, architecture) => {
    expect(resolveEmbeddingLlamaOptions(false, platform, architecture)).toEqual({
      gpu: false,
      gpuLayers: 0,
    });
  });
});
