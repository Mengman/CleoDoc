export type EmbeddingLlamaBackend = false | "metal";

export function resolveEmbeddingLlamaBackend(
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
): EmbeddingLlamaBackend {
  return platform === "darwin" && architecture === "arm64" ? "metal" : false;
}
