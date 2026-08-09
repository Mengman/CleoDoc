import { randomUUID } from "node:crypto";

import type {
  KnowledgeChunk,
  KnowledgeSearchResult,
  KnowledgeSourceIndexStatus,
} from "../../contracts/src/index.js";
import { AppError } from "../../contracts/src/index.js";
import type { ProjectDatabase } from "./project-database.js";

export interface KnowledgeChunkWrite {
  readonly ordinal: number;
  readonly content: string;
  readonly startOffset: number;
  readonly endOffset: number;
}

export interface ReplaceSourceChunksInput {
  readonly sourceId: string;
  readonly expectedContentHash: string;
  readonly parserVersion: string;
  readonly chunkerVersion: string;
  readonly chunkingConfigJson: string;
  readonly chunks: readonly KnowledgeChunkWrite[];
}

interface ChunkRow {
  chunk_id: string;
  source_id: string;
  ordinal: number;
  content: string;
  start_offset: number;
  end_offset: number;
  chunker_version: string;
  created_at: string;
}

interface ExistingChunkRow extends ChunkRow {
  chunk_rowid: number;
}

interface SearchRow extends ChunkRow {
  source_title: string;
  source_label: string | null;
}

export class KnowledgeChunkRepository {
  constructor(private readonly projectDatabase: ProjectDatabase) {}

  async replaceForSource(input: ReplaceSourceChunksInput): Promise<KnowledgeChunk[]> {
    validateChunks(input.chunks);
    return await this.projectDatabase.transaction((database) => {
      const source = database
        .prepare("SELECT content_hash, size FROM sources WHERE id = ? AND source_type = 'material'")
        .get(input.sourceId) as { content_hash: string; size: number } | undefined;
      if (source === undefined) {
        throw new AppError("MATERIAL_NOT_FOUND", "找不到要建立索引的资料。");
      }
      if (source.content_hash !== input.expectedContentHash) {
        throw new AppError("VALIDATION_ERROR", "资料内容已发生变化，已放弃写入过期切片。");
      }
      for (const chunk of input.chunks) {
        if (chunk.endOffset > Number(source.size)) {
          throw new AppError("VALIDATION_ERROR", "切片的原文范围超出了资料长度。");
        }
      }

      const existing = database
        .prepare("SELECT * FROM knowledge_chunks WHERE source_id = ? ORDER BY ordinal")
        .all(input.sourceId) as unknown as ExistingChunkRow[];
      database.prepare("DELETE FROM knowledge_chunks WHERE source_id = ?").run(input.sourceId);

      const insert = database.prepare(
        `INSERT INTO knowledge_chunks
         (chunk_id, source_id, ordinal, content, start_offset, end_offset, chunker_version, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const created: KnowledgeChunk[] = [];
      const now = new Date().toISOString();
      for (const chunk of input.chunks) {
        const previous = existing.find((candidate) => sameChunk(candidate, chunk, input));
        const chunkId = previous?.chunk_id ?? randomUUID();
        const createdAt = previous?.created_at ?? now;
        insert.run(
          chunkId,
          input.sourceId,
          chunk.ordinal,
          chunk.content,
          chunk.startOffset,
          chunk.endOffset,
          input.chunkerVersion,
          createdAt,
        );
        created.push({
          chunkId,
          sourceId: input.sourceId,
          ordinal: chunk.ordinal,
          content: chunk.content,
          startOffset: chunk.startOffset,
          endOffset: chunk.endOffset,
          chunkerVersion: input.chunkerVersion,
          createdAt,
        });
      }

      database
        .prepare(
          `UPDATE sources
           SET parser_version = ?, chunker_version = ?, chunking_config_json = ?,
               index_status = 'ready', index_error_code = NULL, indexed_at = ?
           WHERE id = ?`,
        )
        .run(
          input.parserVersion,
          input.chunkerVersion,
          input.chunkingConfigJson,
          now,
          input.sourceId,
        );
      return created;
    });
  }

  search(projectId: string, query: string, limit: number): KnowledgeSearchResult[] {
    const characters = Array.from(query).length;
    const rows = this.projectDatabase.read((database) => {
      if (characters < 3) {
        return database
          .prepare(
            `SELECT kc.*, s.title AS source_title, s.source_label
             FROM knowledge_chunks kc
             JOIN sources s ON s.id = kc.source_id
             WHERE s.project_id = ? AND s.index_status = 'ready'
               AND instr(kc.content, ?) > 0
             ORDER BY s.updated_at DESC, kc.ordinal
             LIMIT ?`,
          )
          .all(projectId, query, limit) as unknown as SearchRow[];
      }
      return database
        .prepare(
          `SELECT kc.*, s.title AS source_title, s.source_label
           FROM knowledge_chunk_fts fts
           JOIN knowledge_chunks kc ON kc.chunk_rowid = fts.rowid
           JOIN sources s ON s.id = kc.source_id
           WHERE knowledge_chunk_fts MATCH ?
             AND s.project_id = ? AND s.index_status = 'ready'
           ORDER BY bm25(knowledge_chunk_fts), s.updated_at DESC, kc.ordinal
           LIMIT ?`,
        )
        .all(quotedFtsQuery(query), projectId, limit) as unknown as SearchRow[];
    });
    return rows.map(mapSearchResult);
  }

  listStatus(): KnowledgeSourceIndexStatus[] {
    return this.projectDatabase.read((database) =>
      database
        .prepare(
          `SELECT s.id AS source_id, s.title, s.index_status, s.parser_version,
                    s.chunker_version, s.indexed_at, s.index_error_code,
                    COUNT(kc.chunk_rowid) AS chunk_count
             FROM sources s
             LEFT JOIN knowledge_chunks kc ON kc.source_id = s.id
             WHERE s.source_type = 'material'
             GROUP BY s.id
             ORDER BY s.updated_at DESC`,
        )
        .all()
        .map((value) => {
          const row = value as Record<string, unknown>;
          return {
            sourceId: String(row.source_id),
            title: String(row.title),
            status: row.index_status as KnowledgeSourceIndexStatus["status"],
            chunkCount: Number(row.chunk_count),
            parserVersion: nullableString(row.parser_version),
            chunkerVersion: nullableString(row.chunker_version),
            indexedAt: nullableString(row.indexed_at),
            errorCode: nullableString(row.index_error_code),
          };
        }),
    );
  }

  async markOutdated(
    parserVersion: string,
    chunkerVersion: string,
    chunkingConfigJson: string,
  ): Promise<void> {
    await this.projectDatabase.write((database) => {
      database
        .prepare(
          `UPDATE sources SET index_status = 'stale'
           WHERE source_type = 'material' AND index_status = 'ready'
             AND (parser_version IS NOT ? OR chunker_version IS NOT ?
                  OR chunking_config_json IS NOT ?)`,
        )
        .run(parserVersion, chunkerVersion, chunkingConfigJson);
    });
  }

  async markFailed(sourceId: string, errorCode: string): Promise<void> {
    await this.projectDatabase.write((database) => {
      database
        .prepare(
          `UPDATE sources
           SET index_status = 'failed', index_error_code = ?
           WHERE id = ? AND source_type = 'material'`,
        )
        .run(errorCode, sourceId);
    });
  }

  async rebuildFts(): Promise<void> {
    await this.projectDatabase.write((database) => {
      database.exec("INSERT INTO knowledge_chunk_fts(knowledge_chunk_fts) VALUES ('rebuild')");
    });
  }
}

function validateChunks(chunks: readonly KnowledgeChunkWrite[]): void {
  for (const [index, chunk] of chunks.entries()) {
    if (
      chunk.ordinal !== index ||
      chunk.content.length === 0 ||
      chunk.startOffset < 0 ||
      chunk.endOffset <= chunk.startOffset
    ) {
      throw new AppError("VALIDATION_ERROR", "切片集合的顺序、内容或原文范围无效。");
    }
  }
}

function sameChunk(
  existing: ExistingChunkRow,
  chunk: KnowledgeChunkWrite,
  input: ReplaceSourceChunksInput,
): boolean {
  return (
    existing.ordinal === chunk.ordinal &&
    existing.content === chunk.content &&
    existing.start_offset === chunk.startOffset &&
    existing.end_offset === chunk.endOffset &&
    existing.chunker_version === input.chunkerVersion
  );
}

function quotedFtsQuery(query: string): string {
  return `"${query.replaceAll('"', '""')}"`;
}

function mapSearchResult(row: SearchRow): KnowledgeSearchResult {
  return {
    chunkId: row.chunk_id,
    sourceId: row.source_id,
    ordinal: Number(row.ordinal),
    content: row.content,
    startOffset: Number(row.start_offset),
    endOffset: Number(row.end_offset),
    chunkerVersion: row.chunker_version,
    createdAt: row.created_at,
    sourceTitle: row.source_title,
    sourceLabel: row.source_label,
  };
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}
