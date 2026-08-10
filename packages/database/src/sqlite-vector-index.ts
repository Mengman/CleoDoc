import type { DatabaseSync } from "node:sqlite";
import * as sqliteVec from "sqlite-vec";

import {
  AppError,
  type VectorIndex,
  type VectorSearchFilter,
  type VectorSearchHit,
} from "../../contracts/src/index.js";
import { encodeFloat32LittleEndian } from "./float32-vector.js";
import type { ProjectDatabase } from "./project-database.js";

const REQUIRED_SQLITE_VEC_VERSION = "v0.1.9";

interface VectorSearchRow {
  chunk_id: string;
  source_id: string;
  content: string;
  start_offset: number;
  end_offset: number;
  source_title: string;
  source_revision: string;
  source_updated_at: string;
  distance: number;
}

export class SqliteVectorIndex implements VectorIndex {
  private constructor(
    private readonly projectDatabase: ProjectDatabase,
    readonly extensionVersion: string,
  ) {}

  static open(projectDatabase: ProjectDatabase): SqliteVectorIndex {
    let extensionVersion: string;
    try {
      extensionVersion = projectDatabase.read((database) => loadExtension(database));
    } catch (error) {
      throw new AppError("VECTOR_INDEX_UNAVAILABLE", "无法加载本地 sqlite-vec 向量扩展。", {
        cause: error,
      });
    }
    if (extensionVersion !== REQUIRED_SQLITE_VEC_VERSION) {
      throw new AppError(
        "VECTOR_INDEX_UNAVAILABLE",
        `sqlite-vec 版本不匹配：需要 ${REQUIRED_SQLITE_VEC_VERSION}，实际为 ${extensionVersion}。`,
      );
    }
    return new SqliteVectorIndex(projectDatabase, extensionVersion);
  }

  async search(
    query: Float32Array,
    filter: VectorSearchFilter,
    limit: number,
  ): Promise<readonly VectorSearchHit[]> {
    validateSearch(filter, limit);
    const queryBytes = encodeFloat32LittleEndian(query);

    try {
      return this.projectDatabase.read((database) => {
        const expectedDimensions = findExpectedDimensions(database, filter);
        if (expectedDimensions === undefined) return [];
        if (expectedDimensions !== query.length) {
          throw new AppError(
            "VALIDATION_ERROR",
            `查询向量维度 ${query.length} 与索引向量维度 ${expectedDimensions} 不一致。`,
          );
        }

        const rows = database
          .prepare(
            `SELECT kc.chunk_id, kc.source_id, kc.content,
                    kc.start_offset, kc.end_offset, s.title AS source_title,
                    s.content_hash AS source_revision, s.updated_at AS source_updated_at,
                    vec_distance_cosine(vec_f32(ce.embedding), vec_f32(?)) AS distance
             FROM chunk_embeddings ce
             JOIN embedding_models em
               ON em.embedding_model_rowid = ce.embedding_model_rowid
             JOIN knowledge_chunks kc ON kc.chunk_rowid = ce.chunk_rowid
             JOIN sources s ON s.id = kc.source_id
             WHERE s.project_id = ? AND s.source_type = ?
               AND s.index_status = 'ready'
               AND (? IS NULL OR s.id = ?)
               AND (? IS NULL OR s.content_hash = ?)
               AND em.model_name = ? AND em.revision = ?
               AND ce.content_hash = kc.content_hash
               AND length(ce.embedding) = ?
             ORDER BY distance ASC, s.updated_at DESC, kc.ordinal ASC
             LIMIT ?`,
          )
          .all(
            queryBytes,
            filter.projectId,
            filter.sourceType,
            filter.sourceId ?? null,
            filter.sourceId ?? null,
            filter.sourceRevision ?? null,
            filter.sourceRevision ?? null,
            filter.embeddingModelName,
            filter.embeddingModelRevision,
            expectedDimensions * 4,
            limit,
          ) as unknown as VectorSearchRow[];
        return rows.map(mapSearchHit);
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("DATABASE_ERROR", "sqlite-vec 精确向量检索失败。", { cause: error });
    }
  }
}

function loadExtension(database: DatabaseSync): string {
  database.enableLoadExtension(true);
  try {
    sqliteVec.load(database);
  } finally {
    database.enableLoadExtension(false);
  }
  const row = database.prepare("SELECT vec_version() AS version").get() as
    { version: string } | undefined;
  if (row === undefined) {
    throw new Error("sqlite-vec did not report its version");
  }
  return row.version;
}

function findExpectedDimensions(
  database: DatabaseSync,
  filter: VectorSearchFilter,
): number | undefined {
  const row = database
    .prepare(
      `SELECT vec_length(vec_f32(ce.embedding)) AS dimensions
       FROM chunk_embeddings ce
       JOIN embedding_models em
         ON em.embedding_model_rowid = ce.embedding_model_rowid
       JOIN knowledge_chunks kc ON kc.chunk_rowid = ce.chunk_rowid
       JOIN sources s ON s.id = kc.source_id
       WHERE s.project_id = ? AND s.source_type = ?
         AND s.index_status = 'ready'
         AND (? IS NULL OR s.id = ?)
         AND (? IS NULL OR s.content_hash = ?)
         AND em.model_name = ? AND em.revision = ?
         AND ce.content_hash = kc.content_hash
       LIMIT 1`,
    )
    .get(
      filter.projectId,
      filter.sourceType,
      filter.sourceId ?? null,
      filter.sourceId ?? null,
      filter.sourceRevision ?? null,
      filter.sourceRevision ?? null,
      filter.embeddingModelName,
      filter.embeddingModelRevision,
    ) as { dimensions: number } | undefined;
  return row === undefined ? undefined : Number(row.dimensions);
}

function validateSearch(filter: VectorSearchFilter, limit: number): void {
  if (
    filter.projectId.trim() === "" ||
    filter.sourceType !== "material" ||
    filter.embeddingModelName.trim() === "" ||
    filter.embeddingModelRevision.trim() === ""
  ) {
    throw new AppError("VALIDATION_ERROR", "向量检索缺少项目或 Embedding 模型范围。");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new AppError("VALIDATION_ERROR", "向量检索结果数量必须为 1–100。");
  }
}

function mapSearchHit(row: VectorSearchRow): VectorSearchHit {
  const distance = Number(row.distance);
  if (!Number.isFinite(distance)) {
    throw new AppError("DATABASE_ERROR", "sqlite-vec 返回了无效的余弦距离。");
  }
  return {
    chunk: {
      chunkId: row.chunk_id,
      sourceId: row.source_id,
      content: row.content,
      startOffset: Number(row.start_offset),
      endOffset: Number(row.end_offset),
      sourceTitle: row.source_title,
      sourceRevision: row.source_revision,
      sourceUpdatedAt: row.source_updated_at,
    },
    distance,
  };
}
