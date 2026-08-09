import { AppError } from "../../contracts/src/index.js";
import type {
  EmbeddingChunkInput,
  EmbeddingChunkResult,
  EmbeddingResult,
  EmbeddingTaskProgress,
} from "./embedding-types.js";

export interface EmbeddingBatchRuntime {
  readonly modelId: string;
  embedDocument(content: string): Promise<EmbeddingResult>;
}

export interface EmbeddingBatchProcessorOptions {
  readonly runtime: EmbeddingBatchRuntime;
  readonly chunks: readonly EmbeddingChunkInput[];
  readonly completedBeforeBatch: number;
  readonly totalChunks: number;
  readonly isCancelled?: () => boolean;
  readonly onProgress?: (progress: EmbeddingTaskProgress) => void;
}

export async function processEmbeddingBatch(
  options: EmbeddingBatchProcessorOptions,
): Promise<EmbeddingChunkResult[]> {
  const results: EmbeddingChunkResult[] = [];
  for (const [index, chunk] of options.chunks.entries()) {
    if (options.isCancelled?.() === true) throw embeddingTaskCancelled();
    const embedding = await options.runtime.embedDocument(chunk.content);
    if (options.isCancelled?.() === true) throw embeddingTaskCancelled();

    results.push({
      chunkId: chunk.chunkId,
      tokenCount: embedding.tokenCount,
      vector: embedding.vector,
    });
    options.onProgress?.({
      completedChunks: options.completedBeforeBatch + index + 1,
      totalChunks: options.totalChunks,
      chunkId: chunk.chunkId,
    });
  }
  return results;
}

function embeddingTaskCancelled(): AppError {
  return new AppError("EMBEDDING_TASK_CANCELLED", "Embedding 任务已取消。");
}
