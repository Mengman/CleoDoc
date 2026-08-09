import { Worker } from "node:worker_threads";

import { AppError } from "../../contracts/src/index.js";
import type {
  EmbeddingChunkInput,
  EmbeddingChunkResult,
  EmbeddingTaskProgress,
  EmbeddingWorkerTaskResult,
  ResolvedEmbeddingModelDefinition,
} from "./embedding-types.js";
import {
  isEmbeddingWorkerResponse,
  type EmbeddingWorkerRequest,
  type EmbeddingWorkerResponse,
} from "./embedding-worker-protocol.js";

export interface EmbeddingWorkerTaskOptions {
  readonly definition: ResolvedEmbeddingModelDefinition;
  readonly chunks: readonly EmbeddingChunkInput[];
  readonly chunkBatchSize: number;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: EmbeddingTaskProgress) => void;
  readonly onBatch?: (results: readonly EmbeddingChunkResult[]) => void | Promise<void>;
}

export async function runEmbeddingWorkerTask(
  options: EmbeddingWorkerTaskOptions,
): Promise<EmbeddingWorkerTaskResult> {
  validateOptions(options);
  if (isAborted(options.signal)) throw embeddingTaskCancelled();
  if (options.chunks.length === 0) {
    return { modelId: options.definition.modelId, processedChunks: 0 };
  }

  const worker = new Worker(resolveWorkerUrl(), {
    name: `embedding-${options.definition.modelId}`,
  });
  try {
    worker.postMessage({
      type: "initialize",
      definition: options.definition,
      totalChunks: options.chunks.length,
    } satisfies EmbeddingWorkerRequest);
    await waitForResponse(worker, options.signal, options.onProgress, (message) =>
      message.type === "ready" ? true : undefined,
    );

    let batchId = 0;
    for (let offset = 0; offset < options.chunks.length; offset += options.chunkBatchSize) {
      if (isAborted(options.signal)) throw embeddingTaskCancelled();
      const chunks = options.chunks.slice(offset, offset + options.chunkBatchSize);
      worker.postMessage({ type: "embed_batch", batchId, chunks } satisfies EmbeddingWorkerRequest);
      const results = await waitForResponse(
        worker,
        options.signal,
        options.onProgress,
        (message) =>
          message.type === "batch_complete" && message.batchId === batchId
            ? message.results
            : undefined,
      );
      await options.onBatch?.(results);
      batchId += 1;
    }

    worker.postMessage({ type: "dispose" } satisfies EmbeddingWorkerRequest);
    await waitForResponse(worker, options.signal, options.onProgress, (message) =>
      message.type === "disposed" ? true : undefined,
    );
    return { modelId: options.definition.modelId, processedChunks: options.chunks.length };
  } finally {
    await worker.terminate();
  }
}

async function waitForResponse<T>(
  worker: Worker,
  signal: AbortSignal | undefined,
  onProgress: EmbeddingWorkerTaskOptions["onProgress"],
  select: (message: EmbeddingWorkerResponse) => T | undefined,
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const cleanup = (): void => {
      worker.off("message", handleMessage);
      worker.off("error", handleError);
      worker.off("exit", handleExit);
      signal?.removeEventListener("abort", handleAbort);
    };
    const finish = (action: () => void): void => {
      cleanup();
      action();
    };
    const handleMessage = (value: unknown): void => {
      if (!isEmbeddingWorkerResponse(value)) {
        finish(() => reject(new AppError("INTERNAL_ERROR", "Embedding Worker 返回了无效消息。")));
        return;
      }
      if (value.type === "progress") {
        onProgress?.(value);
        return;
      }
      if (value.type === "error") {
        finish(() =>
          reject(
            new AppError(value.error.code, value.error.message, { details: value.error.details }),
          ),
        );
        return;
      }
      const selected = select(value);
      if (selected !== undefined) finish(() => resolve(selected));
    };
    const handleError = (error: Error): void => {
      finish(() =>
        reject(
          new AppError("EMBEDDING_GENERATION_FAILED", "Embedding Worker 执行失败。", {
            cause: error,
          }),
        ),
      );
    };
    const handleExit = (code: number): void => {
      finish(() =>
        reject(
          new AppError(
            "EMBEDDING_GENERATION_FAILED",
            `Embedding Worker 意外退出（code ${code}）。`,
          ),
        ),
      );
    };
    const handleAbort = (): void => finish(() => reject(embeddingTaskCancelled()));

    worker.on("message", handleMessage);
    worker.once("error", handleError);
    worker.once("exit", handleExit);
    signal?.addEventListener("abort", handleAbort, { once: true });
    if (signal?.aborted === true) handleAbort();
  });
}

function validateOptions(options: EmbeddingWorkerTaskOptions): void {
  if (!Number.isSafeInteger(options.chunkBatchSize) || options.chunkBatchSize < 1) {
    throw new AppError("CONFIG_ERROR", "Embedding Worker 的 Chunk 批次大小必须是正整数。");
  }
  for (const chunk of options.chunks) {
    if (chunk.chunkId.trim() === "" || chunk.content.trim() === "") {
      throw new AppError("VALIDATION_ERROR", "Embedding Worker 输入的 Chunk 信息不完整。");
    }
  }
}

function resolveWorkerUrl(): URL {
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
  return new URL(`./embedding-worker.${extension}`, import.meta.url);
}

function embeddingTaskCancelled(): AppError {
  return new AppError("EMBEDDING_TASK_CANCELLED", "Embedding 任务已取消。");
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}
