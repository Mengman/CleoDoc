import { describe, expect, it, vi } from "vitest";

import { processEmbeddingBatch } from "./embedding-batch-processor.js";

describe("processEmbeddingBatch", () => {
  it("embeds chunks sequentially with one runtime and reports task progress", async () => {
    const embedDocument = vi.fn(async (content: string) => ({
      vector: Float32Array.from([content.length, 1]),
      tokenCount: content.length,
    }));
    const onProgress = vi.fn();

    const results = await processEmbeddingBatch({
      runtime: { modelId: "test-model", embedDocument },
      chunks: [
        { chunkId: "chunk-1", content: "first" },
        { chunkId: "chunk-2", content: "second" },
      ],
      completedBeforeBatch: 3,
      totalChunks: 5,
      onProgress,
    });

    expect(embedDocument.mock.calls).toEqual([["first"], ["second"]]);
    expect(results).toMatchObject([
      { chunkId: "chunk-1", tokenCount: 5 },
      { chunkId: "chunk-2", tokenCount: 6 },
    ]);
    expect(onProgress.mock.calls.map(([progress]) => progress)).toEqual([
      { completedChunks: 4, totalChunks: 5, chunkId: "chunk-1" },
      { completedChunks: 5, totalChunks: 5, chunkId: "chunk-2" },
    ]);
  });

  it("stops before the next chunk when cancellation is observed", async () => {
    let cancelled = false;
    const embedDocument = vi.fn(async () => {
      cancelled = true;
      return { vector: Float32Array.from([1]), tokenCount: 1 };
    });

    await expect(
      processEmbeddingBatch({
        runtime: { modelId: "test-model", embedDocument },
        chunks: [
          { chunkId: "chunk-1", content: "first" },
          { chunkId: "chunk-2", content: "second" },
        ],
        completedBeforeBatch: 0,
        totalChunks: 2,
        isCancelled: () => cancelled,
      }),
    ).rejects.toMatchObject({ code: "EMBEDDING_TASK_CANCELLED" });
    expect(embedDocument).toHaveBeenCalledTimes(1);
  });
});
