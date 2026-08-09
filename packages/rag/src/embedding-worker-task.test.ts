import { describe, expect, it } from "vitest";

import type { ResolvedEmbeddingModelDefinition } from "./embedding-types.js";
import { runEmbeddingWorkerTask } from "./embedding-worker-task.js";

const definition: ResolvedEmbeddingModelDefinition = {
  language: "zh",
  modelId: "test-model",
  modelName: "test/model",
  revision: "test",
  modelFile: "test.gguf",
  modelPath: "missing.gguf",
  maxInputTokens: 512,
  queryPrefix: "",
};

describe("runEmbeddingWorkerTask", () => {
  it("does not start a worker when there are no chunks", async () => {
    await expect(
      runEmbeddingWorkerTask({
        definition,
        gpuAcceleration: false,
        chunks: [],
        chunkBatchSize: 16,
      }),
    ).resolves.toEqual({ modelId: "test-model", processedChunks: 0 });
  });

  it("rejects an already cancelled task before starting a worker", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      runEmbeddingWorkerTask({
        definition,
        gpuAcceleration: false,
        chunks: [{ chunkId: "chunk-1", content: "content" }],
        chunkBatchSize: 16,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "EMBEDDING_TASK_CANCELLED" });
  });

  it("rejects an invalid task batch size", async () => {
    await expect(
      runEmbeddingWorkerTask({
        definition,
        gpuAcceleration: false,
        chunks: [],
        chunkBatchSize: 0,
      }),
    ).rejects.toMatchObject({ code: "CONFIG_ERROR" });
  });
});
