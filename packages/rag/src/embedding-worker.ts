import { parentPort } from "node:worker_threads";

import { asAppError } from "../../contracts/src/index.js";
import { processEmbeddingBatch } from "./embedding-batch-processor.js";
import type {
  EmbeddingWorkerRequest,
  EmbeddingWorkerResponse,
  SerializedEmbeddingWorkerError,
} from "./embedding-worker-protocol.js";
import { NodeLlamaCppEmbeddingRuntime } from "./node-llama-cpp-embedding.js";

if (parentPort === null) throw new Error("Embedding Worker 必须在 Worker Thread 中运行。");

let runtime: NodeLlamaCppEmbeddingRuntime | null = null;
let totalChunks = 0;
let completedChunks = 0;

parentPort.on("message", (message: EmbeddingWorkerRequest) => {
  void handleMessage(message).catch((error: unknown) => {
    postMessage({ type: "error", error: serializeError(error) });
  });
});

async function handleMessage(message: EmbeddingWorkerRequest): Promise<void> {
  switch (message.type) {
    case "initialize":
      totalChunks = message.totalChunks;
      completedChunks = 0;
      runtime = await NodeLlamaCppEmbeddingRuntime.open(message.definition, {
        gpuAcceleration: message.gpuAcceleration,
      });
      postMessage({ type: "ready", info: runtime.info });
      return;
    case "embed_batch": {
      if (runtime === null) throw new Error("Embedding Worker 尚未初始化。");
      const results = await processEmbeddingBatch({
        runtime,
        chunks: message.chunks,
        completedBeforeBatch: completedChunks,
        totalChunks,
        onProgress: (progress) => postMessage({ type: "progress", ...progress }),
      });
      completedChunks += results.length;
      const response: EmbeddingWorkerResponse = {
        type: "batch_complete",
        batchId: message.batchId,
        results,
      };
      parentPort!.postMessage(
        response,
        results.map((result) => result.vector.buffer as ArrayBuffer),
      );
      return;
    }
    case "dispose":
      await runtime?.dispose();
      runtime = null;
      postMessage({ type: "disposed" });
  }
}

function postMessage(message: EmbeddingWorkerResponse): void {
  parentPort!.postMessage(message);
}

function serializeError(error: unknown): SerializedEmbeddingWorkerError {
  const appError = asAppError(error);
  return { code: appError.code, message: appError.message, details: appError.details };
}
