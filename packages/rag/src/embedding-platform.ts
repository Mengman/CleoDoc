export interface EmbeddingLlamaOptions {
  readonly gpu: false | "metal" | "auto";
  readonly gpuLayers: 0 | "auto";
}

export function resolveEmbeddingLlamaOptions(
  gpuAcceleration: boolean,
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
): EmbeddingLlamaOptions {
  if (gpuAcceleration) {
    return { gpu: "auto", gpuLayers: "auto" };
  }
  return {
    gpu: platform === "darwin" && architecture === "arm64" ? "metal" : false,
    gpuLayers: 0,
  };
}
