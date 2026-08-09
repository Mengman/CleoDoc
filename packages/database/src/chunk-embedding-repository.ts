import { AppError, type KnowledgeSourceLanguage } from "../../contracts/src/index.js";
import type { DatabaseSync } from "node:sqlite";
import type { ProjectDatabase } from "./project-database.js";

export interface EmbeddingModelIdentity {
  readonly modelId: string;
  readonly modelName: string;
  readonly revision: string;
}

export interface PendingChunkEmbedding {
  readonly chunkId: string;
  readonly sourceId: string;
  readonly sourceContentHash: string;
  readonly chunkContentHash: string;
  readonly chunkingConfigJson: string;
  readonly content: string;
}

export interface PendingChunkEmbeddingSet {
  readonly totalChunks: number;
  readonly chunks: readonly PendingChunkEmbedding[];
}

export interface ChunkEmbeddingWrite {
  readonly snapshot: PendingChunkEmbedding;
  readonly vector: Float32Array;
}

export interface ChunkEmbeddingWriteResult {
  readonly writtenCount: number;
  readonly discardedCount: number;
}

interface CandidateRow {
  chunk_id: string;
  source_id: string;
  source_content_hash: string;
  chunk_content_hash: string;
  chunking_config_json: string | null;
  content: string;
  embedding_content_hash: string | null;
}

interface CurrentChunkRow {
  chunk_rowid: number;
  project_id: string;
  source_content_hash: string;
  chunk_content_hash: string;
  chunking_config_json: string | null;
  primary_language: string | null;
  index_status: string;
}

export class ChunkEmbeddingRepository {
  constructor(private readonly projectDatabase: ProjectDatabase) {}

  listPending(
    projectId: string,
    language: KnowledgeSourceLanguage,
    modelId: string,
  ): PendingChunkEmbeddingSet {
    const rows = this.projectDatabase.read(
      (database) =>
        database
          .prepare(
            `SELECT kc.chunk_id, kc.source_id, kc.content,
                    kc.content_hash AS chunk_content_hash,
                    s.content_hash AS source_content_hash,
                    s.chunking_config_json,
                    ce.content_hash AS embedding_content_hash
             FROM knowledge_chunks kc
             JOIN sources s ON s.id = kc.source_id
             LEFT JOIN chunk_embeddings ce
               ON ce.chunk_rowid = kc.chunk_rowid AND ce.embedding_model_id = ?
             WHERE s.project_id = ? AND s.source_type = 'material'
               AND s.index_status = 'ready'
               AND json_extract(s.languages_json, '$[0]') = ?
             ORDER BY s.updated_at DESC, kc.ordinal`,
          )
          .all(modelId, projectId, language) as unknown as CandidateRow[],
    );

    const chunks = rows
      .filter((row) => row.embedding_content_hash !== row.chunk_content_hash)
      .map((row) => {
        if (row.chunking_config_json === null) {
          throw new AppError("DATABASE_ERROR", "可用资料索引缺少切片配置。");
        }
        return mapPendingChunk(row, row.chunking_config_json);
      });
    return { totalChunks: rows.length, chunks };
  }

  async writeBatch(
    projectId: string,
    language: KnowledgeSourceLanguage,
    model: EmbeddingModelIdentity,
    writes: readonly ChunkEmbeddingWrite[],
  ): Promise<ChunkEmbeddingWriteResult> {
    validateWrites(writes);
    if (writes.length === 0) return { writtenCount: 0, discardedCount: 0 };

    return await this.projectDatabase.transaction((database) => {
      const currentStatement = database.prepare(
        `SELECT kc.chunk_rowid, s.project_id,
                s.content_hash AS source_content_hash,
                kc.content_hash AS chunk_content_hash,
                s.chunking_config_json,
                json_extract(s.languages_json, '$[0]') AS primary_language,
                s.index_status
         FROM knowledge_chunks kc
         JOIN sources s ON s.id = kc.source_id
         WHERE kc.chunk_id = ? AND kc.source_id = ?`,
      );
      const valid: Array<{ write: ChunkEmbeddingWrite; chunkRowid: number }> = [];
      for (const write of writes) {
        const current = currentStatement.get(write.snapshot.chunkId, write.snapshot.sourceId) as
          CurrentChunkRow | undefined;
        if (!isCurrent(current, projectId, language, write.snapshot)) continue;
        valid.push({ write, chunkRowid: Number(current.chunk_rowid) });
      }

      if (valid.length === 0) {
        return { writtenCount: 0, discardedCount: writes.length };
      }
      ensureModel(database, model);
      ensureEmbeddingDimensions(database, model.modelId, valid[0]!.write.vector.length);

      const insert = database.prepare(
        `INSERT INTO chunk_embeddings
         (embedding_model_id, chunk_rowid, content_hash, embedding, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(embedding_model_id, chunk_rowid) DO UPDATE SET
           content_hash = excluded.content_hash,
           embedding = excluded.embedding,
           created_at = excluded.created_at`,
      );
      const now = new Date().toISOString();
      for (const item of valid) {
        insert.run(
          model.modelId,
          item.chunkRowid,
          item.write.snapshot.chunkContentHash,
          encodeFloat32LittleEndian(item.write.vector),
          now,
        );
      }
      return {
        writtenCount: valid.length,
        discardedCount: writes.length - valid.length,
      };
    });
  }
}

function mapPendingChunk(row: CandidateRow, chunkingConfigJson: string): PendingChunkEmbedding {
  return {
    chunkId: row.chunk_id,
    sourceId: row.source_id,
    sourceContentHash: row.source_content_hash,
    chunkContentHash: row.chunk_content_hash,
    chunkingConfigJson,
    content: row.content,
  };
}

function isCurrent(
  current: CurrentChunkRow | undefined,
  projectId: string,
  language: KnowledgeSourceLanguage,
  snapshot: PendingChunkEmbedding,
): current is CurrentChunkRow {
  return (
    current !== undefined &&
    current.project_id === projectId &&
    current.index_status === "ready" &&
    current.primary_language === language &&
    current.source_content_hash === snapshot.sourceContentHash &&
    current.chunk_content_hash === snapshot.chunkContentHash &&
    current.chunking_config_json === snapshot.chunkingConfigJson
  );
}

function validateWrites(writes: readonly ChunkEmbeddingWrite[]): void {
  for (const write of writes) {
    if (write.vector.length === 0) {
      throw new AppError("VALIDATION_ERROR", "Embedding 向量不能为空。");
    }
    for (const value of write.vector) {
      if (!Number.isFinite(value)) {
        throw new AppError("VALIDATION_ERROR", "Embedding 向量包含无效数值。");
      }
    }
  }
  const dimensions = new Set(writes.map((write) => write.vector.length));
  if (dimensions.size > 1) {
    throw new AppError("VALIDATION_ERROR", "同一批次的 Embedding 向量维度不一致。");
  }
}

function ensureModel(database: DatabaseSync, model: EmbeddingModelIdentity): void {
  const byId = database
    .prepare(`SELECT model_name, revision FROM embedding_models WHERE embedding_model_id = ?`)
    .get(model.modelId) as { model_name: string; revision: string } | undefined;
  if (byId !== undefined) {
    if (byId.model_name !== model.modelName || byId.revision !== model.revision) {
      throw new AppError("CONFIG_ERROR", "Embedding 模型 ID 对应了不同的模型版本。");
    }
    return;
  }

  const byRevision = database
    .prepare(
      `SELECT embedding_model_id FROM embedding_models
       WHERE model_name = ? AND revision = ?`,
    )
    .get(model.modelName, model.revision) as { embedding_model_id: string } | undefined;
  if (byRevision !== undefined) {
    throw new AppError("CONFIG_ERROR", "同一个 Embedding 模型版本使用了不同的模型 ID。");
  }
  database
    .prepare(
      `INSERT INTO embedding_models
       (embedding_model_id, model_name, revision, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(model.modelId, model.modelName, model.revision, new Date().toISOString());
}

function ensureEmbeddingDimensions(
  database: DatabaseSync,
  modelId: string,
  dimensions: number,
): void {
  const existing = database
    .prepare(
      `SELECT length(embedding) AS byte_length
       FROM chunk_embeddings WHERE embedding_model_id = ? LIMIT 1`,
    )
    .get(modelId) as { byte_length: number } | undefined;
  if (existing !== undefined && Number(existing.byte_length) !== dimensions * 4) {
    throw new AppError("VALIDATION_ERROR", "Embedding 向量维度与已有模型向量不一致。");
  }
}

function encodeFloat32LittleEndian(vector: Float32Array): Uint8Array {
  const bytes = Buffer.allocUnsafe(vector.length * 4);
  for (let index = 0; index < vector.length; index += 1) {
    bytes.writeFloatLE(vector[index]!, index * 4);
  }
  return bytes;
}
