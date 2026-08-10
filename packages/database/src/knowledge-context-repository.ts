import { AppError } from "../../contracts/src/index.js";
import type { ProjectDatabase } from "./project-database.js";

export interface KnowledgeContextChunk {
  readonly chunkId: string;
  readonly content: string;
}

export interface KnowledgeChunkContext {
  readonly sourceId: string;
  readonly sourceTitle: string;
  readonly targetChunkId: string;
  readonly chunks: readonly KnowledgeContextChunk[];
}

interface SourceRow {
  title: string;
  index_status: "pending" | "ready" | "stale" | "failed";
}

interface TargetRow {
  source_id: string;
  ordinal: number;
}

interface ContextRow {
  chunk_id: string;
  content: string;
}

export class KnowledgeContextRepository {
  constructor(private readonly projectDatabase: ProjectDatabase) {}

  read(
    projectId: string,
    sourceId: string,
    chunkId: string,
    before: number,
    after: number,
  ): KnowledgeChunkContext {
    validateInput(projectId, sourceId, chunkId, before, after);
    return this.projectDatabase.read((database) => {
      const source = database
        .prepare(
          `SELECT title, index_status
           FROM sources
           WHERE id = ? AND project_id = ? AND source_type = 'material'`,
        )
        .get(sourceId, projectId) as SourceRow | undefined;
      if (source === undefined) {
        throw new AppError("MATERIAL_NOT_FOUND", "当前项目中找不到指定资料。");
      }
      if (source.index_status !== "ready") {
        throw new AppError("MATERIAL_NOT_INDEXED", "指定资料尚未完成有效索引。");
      }

      const target = database
        .prepare(
          `SELECT kc.source_id, kc.ordinal
           FROM knowledge_chunks kc
           JOIN sources s ON s.id = kc.source_id
           WHERE kc.chunk_id = ? AND s.project_id = ? AND s.source_type = 'material'`,
        )
        .get(chunkId, projectId) as TargetRow | undefined;
      if (target === undefined) {
        throw new AppError("KNOWLEDGE_CHUNK_NOT_FOUND", "当前项目中找不到指定资料片段。");
      }
      if (target.source_id !== sourceId) {
        throw new AppError("CHUNK_SOURCE_MISMATCH", "资料片段不属于指定资料。");
      }

      const rows = database
        .prepare(
          `SELECT chunk_id, content
           FROM knowledge_chunks
           WHERE source_id = ? AND ordinal BETWEEN ? AND ?
           ORDER BY ordinal`,
        )
        .all(
          sourceId,
          Math.max(0, target.ordinal - before),
          target.ordinal + after,
        ) as unknown as ContextRow[];
      return {
        sourceId,
        sourceTitle: source.title,
        targetChunkId: chunkId,
        chunks: rows.map((row) => ({ chunkId: row.chunk_id, content: row.content })),
      };
    });
  }
}

function validateInput(
  projectId: string,
  sourceId: string,
  chunkId: string,
  before: number,
  after: number,
): void {
  if (projectId.trim() === "" || sourceId.trim() === "" || chunkId.trim() === "") {
    throw new AppError("VALIDATION_ERROR", "资料上下文查询缺少必要标识。");
  }
  if (![before, after].every((value) => Number.isInteger(value) && value >= 0 && value <= 3)) {
    throw new AppError("VALIDATION_ERROR", "相邻资料片段数量必须是 0–3 的整数。");
  }
}
