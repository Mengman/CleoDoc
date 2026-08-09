import { AppError, type KnowledgeSourceLanguage } from "../../contracts/src/index.js";
import {
  ChunkEmbeddingRepository,
  type PendingChunkEmbedding,
  type ProjectDatabase,
} from "../../database/src/index.js";
import type {
  MaterialEmbeddingIndexOptions,
  MaterialEmbeddingIndexResult,
  MaterialEmbeddingModel,
  MaterialEmbeddingModelResult,
} from "./material-types.js";

export class MaterialEmbeddingIndexer {
  private readonly repository: ChunkEmbeddingRepository;

  constructor(
    private readonly projectId: string,
    database: ProjectDatabase,
    private readonly models: Readonly<Record<KnowledgeSourceLanguage, MaterialEmbeddingModel>>,
    private readonly chunkBatchSize: number,
  ) {
    this.repository = new ChunkEmbeddingRepository(database);
  }

  async embed(options: MaterialEmbeddingIndexOptions = {}): Promise<MaterialEmbeddingIndexResult> {
    const models: MaterialEmbeddingModelResult[] = [];
    for (const language of ["zh", "en"] as const) {
      models.push(await this.embedLanguage(language, options));
    }
    return summarize(models);
  }

  private async embedLanguage(
    language: KnowledgeSourceLanguage,
    options: MaterialEmbeddingIndexOptions,
  ): Promise<MaterialEmbeddingModelResult> {
    const model = this.models[language];
    const pending = this.repository.listPending(this.projectId, language, model.modelId);
    let writtenChunks = 0;
    let discardedChunks = 0;
    const snapshots = new Map(pending.chunks.map((chunk) => [chunk.chunkId, chunk] as const));

    await model.runEmbeddingTask({
      chunks: pending.chunks.map(({ chunkId, content }) => ({ chunkId, content })),
      chunkBatchSize: this.chunkBatchSize,
      signal: options.signal,
      onProgress: (progress) =>
        options.onProgress?.({ language, modelId: model.modelId, ...progress }),
      onBatch: async (results) => {
        const writes = results.map((result) => ({
          snapshot: requireSnapshot(snapshots, result.chunkId),
          vector: result.vector,
        }));
        const written = await this.repository.writeBatch(
          this.projectId,
          language,
          {
            modelId: model.modelId,
            modelName: model.modelName,
            revision: model.modelRevision,
          },
          writes,
        );
        writtenChunks += written.writtenCount;
        discardedChunks += written.discardedCount;
      },
    });

    return {
      language,
      modelId: model.modelId,
      totalChunks: pending.totalChunks,
      processedChunks: pending.chunks.length,
      skippedChunks: pending.totalChunks - pending.chunks.length,
      writtenChunks,
      discardedChunks,
    };
  }
}

function requireSnapshot(
  snapshots: ReadonlyMap<string, PendingChunkEmbedding>,
  chunkId: string,
): PendingChunkEmbedding {
  const snapshot = snapshots.get(chunkId);
  if (snapshot === undefined) {
    throw new AppError("INTERNAL_ERROR", `Embedding Worker 返回了未知 Chunk：${chunkId}`);
  }
  return snapshot;
}

function summarize(models: readonly MaterialEmbeddingModelResult[]): MaterialEmbeddingIndexResult {
  const total = (select: (result: MaterialEmbeddingModelResult) => number): number =>
    models.reduce((sum, result) => sum + select(result), 0);
  return {
    totalChunks: total((result) => result.totalChunks),
    processedChunks: total((result) => result.processedChunks),
    skippedChunks: total((result) => result.skippedChunks),
    writtenChunks: total((result) => result.writtenChunks),
    discardedChunks: total((result) => result.discardedChunks),
    models,
  };
}
