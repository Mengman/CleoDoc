import { createHash, randomUUID } from "node:crypto";

import type {
  KnowledgeChunk,
  KnowledgeSearchFilter,
  KnowledgeSourceIndexStatus,
  RetrievedChunk,
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

export interface SourceIndexExpectation {
  readonly sourceId: string;
  readonly chunkingConfigJson: string;
}

interface ChunkRow {
  chunk_id: string;
  source_id: string;
  ordinal: number;
  content: string;
  content_hash: string;
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
  source_revision: string;
  source_updated_at: string;
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

      const drafts = input.chunks.map((chunk) => ({
        ...chunk,
        contentHash: hashContent(chunk.content),
      }));
      const unmatchedRowids = new Set(existing.map((chunk) => chunk.chunk_rowid));
      const exactByLocation = new Map(
        existing.map((chunk) => [existingChunkKey(chunk), chunk] as const),
      );
      const byOrdinal = new Map(existing.map((chunk) => [Number(chunk.ordinal), chunk] as const));
      const assignments = drafts.map((chunk) => {
        const exact = exactByLocation.get(draftChunkKey(chunk));
        if (
          exact !== undefined &&
          unmatchedRowids.has(exact.chunk_rowid) &&
          exact.content === chunk.content
        ) {
          unmatchedRowids.delete(exact.chunk_rowid);
          return { chunk, existing: exact, projectionChanged: false };
        }
        const positional = byOrdinal.get(chunk.ordinal);
        if (positional !== undefined && unmatchedRowids.has(positional.chunk_rowid)) {
          unmatchedRowids.delete(positional.chunk_rowid);
          return { chunk, existing: positional, projectionChanged: true };
        }
        return { chunk, existing: null, projectionChanged: false };
      });

      const temporaryOrdinalBase =
        Math.max(input.chunks.length, ...existing.map((chunk) => Number(chunk.ordinal) + 1)) + 1;
      const stageUnchanged = database.prepare(
        `UPDATE knowledge_chunks
         SET ordinal = ?, chunker_version = ?
         WHERE chunk_rowid = ?`,
      );
      const stageChanged = database.prepare(
        `UPDATE knowledge_chunks
         SET ordinal = ?, content = ?, content_hash = ?, start_offset = ?, end_offset = ?,
             chunker_version = ?
         WHERE chunk_rowid = ?`,
      );
      for (const assignment of assignments) {
        if (assignment.existing === null) continue;
        const temporaryOrdinal = temporaryOrdinalBase + assignment.chunk.ordinal;
        if (assignment.projectionChanged) {
          stageChanged.run(
            temporaryOrdinal,
            assignment.chunk.content,
            assignment.chunk.contentHash,
            assignment.chunk.startOffset,
            assignment.chunk.endOffset,
            input.chunkerVersion,
            assignment.existing.chunk_rowid,
          );
        } else {
          stageUnchanged.run(
            temporaryOrdinal,
            input.chunkerVersion,
            assignment.existing.chunk_rowid,
          );
        }
      }

      const remove = database.prepare("DELETE FROM knowledge_chunks WHERE chunk_rowid = ?");
      for (const chunkRowid of unmatchedRowids) remove.run(chunkRowid);

      const finalizeOrdinal = database.prepare(
        "UPDATE knowledge_chunks SET ordinal = ? WHERE chunk_rowid = ?",
      );
      for (const assignment of assignments) {
        if (assignment.existing !== null) {
          finalizeOrdinal.run(assignment.chunk.ordinal, assignment.existing.chunk_rowid);
        }
      }

      const insert = database.prepare(
        `INSERT INTO knowledge_chunks
         (chunk_id, source_id, ordinal, content, content_hash, start_offset, end_offset,
          chunker_version, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const created: KnowledgeChunk[] = [];
      const now = new Date().toISOString();
      for (const assignment of assignments) {
        const chunk = assignment.chunk;
        const chunkId = assignment.existing?.chunk_id ?? randomUUID();
        const createdAt = assignment.existing?.created_at ?? now;
        if (assignment.existing === null) {
          insert.run(
            chunkId,
            input.sourceId,
            chunk.ordinal,
            chunk.content,
            chunk.contentHash,
            chunk.startOffset,
            chunk.endOffset,
            input.chunkerVersion,
            createdAt,
          );
        }
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

  search(projectId: string, query: string, limit: number): RetrievedChunk[] {
    const filter = { projectId, sourceType: "material" as const };
    return Array.from(query).length < 3
      ? this.searchExact(filter, query, limit)
      : this.searchFts(filter, query, limit);
  }

  searchExact(filter: KnowledgeSearchFilter, query: string, limit: number): RetrievedChunk[] {
    validateSearch(filter, limit);
    const rows = this.projectDatabase.read((database) => {
      return database
        .prepare(
          `SELECT kc.*, s.title AS source_title,
                  s.content_hash AS source_revision, s.updated_at AS source_updated_at
           FROM knowledge_chunks kc
           JOIN sources s ON s.id = kc.source_id
           WHERE s.project_id = ? AND s.source_type = ? AND s.index_status = 'ready'
             AND (? IS NULL OR s.id = ?)
             AND (? IS NULL OR s.content_hash = ?)
             AND (instr(kc.content, ?) > 0 OR instr(s.title, ?) > 0)
           ORDER BY CASE
                      WHEN s.title = ? THEN 0
                      WHEN instr(s.title, ?) > 0 THEN 1
                      ELSE 2
                    END,
                    instr(kc.content, ?), s.updated_at DESC, kc.ordinal
           LIMIT ?`,
        )
        .all(
          filter.projectId,
          filter.sourceType,
          filter.sourceId ?? null,
          filter.sourceId ?? null,
          filter.sourceRevision ?? null,
          filter.sourceRevision ?? null,
          query,
          query,
          query,
          query,
          query,
          limit,
        ) as unknown as SearchRow[];
    });
    return rows.map(mapSearchResult);
  }

  searchFts(filter: KnowledgeSearchFilter, query: string, limit: number): RetrievedChunk[] {
    validateSearch(filter, limit);
    const ftsQuery = buildFtsQuery(query);
    if (ftsQuery === null) return [];
    const rows = this.projectDatabase.read(
      (database) =>
        database
          .prepare(
            `SELECT kc.*, s.title AS source_title,
                    s.content_hash AS source_revision, s.updated_at AS source_updated_at
             FROM knowledge_chunk_fts fts
             JOIN knowledge_chunks kc ON kc.chunk_rowid = fts.rowid
             JOIN sources s ON s.id = kc.source_id
             WHERE knowledge_chunk_fts MATCH ?
               AND s.project_id = ? AND s.source_type = ? AND s.index_status = 'ready'
               AND (? IS NULL OR s.id = ?)
               AND (? IS NULL OR s.content_hash = ?)
             ORDER BY bm25(knowledge_chunk_fts), s.updated_at DESC, kc.ordinal
             LIMIT ?`,
          )
          .all(
            ftsQuery,
            filter.projectId,
            filter.sourceType,
            filter.sourceId ?? null,
            filter.sourceId ?? null,
            filter.sourceRevision ?? null,
            filter.sourceRevision ?? null,
            limit,
          ) as unknown as SearchRow[],
    );
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
    expectations: readonly SourceIndexExpectation[],
  ): Promise<void> {
    await this.projectDatabase.transaction((database) => {
      const update = database.prepare(
        `UPDATE sources SET index_status = 'stale'
         WHERE id = ? AND source_type = 'material' AND index_status = 'ready'
           AND (parser_version IS NOT ? OR chunker_version IS NOT ?
                OR chunking_config_json IS NOT ?)`,
      );
      for (const expectation of expectations) {
        update.run(
          expectation.sourceId,
          parserVersion,
          chunkerVersion,
          expectation.chunkingConfigJson,
        );
      }
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

function existingChunkKey(
  chunk: Pick<ChunkRow, "content_hash" | "start_offset" | "end_offset">,
): string {
  return `${chunk.start_offset}:${chunk.end_offset}:${chunk.content_hash}`;
}

function draftChunkKey(chunk: {
  readonly contentHash: string;
  readonly startOffset: number;
  readonly endOffset: number;
}): string {
  return `${chunk.startOffset}:${chunk.endOffset}:${chunk.contentHash}`;
}

function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function buildFtsQuery(query: string): string | null {
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const segment of query.match(/[\p{Script=Han}A-Za-z0-9]+/gu) ?? []) {
    const characters = Array.from(segment);
    if (characters.length < 3) continue;
    if (/^[A-Za-z0-9]+$/u.test(segment)) {
      addFtsTerm(terms, seen, segment.toLocaleLowerCase("en-US"));
      continue;
    }
    for (let index = 0; index <= characters.length - 3 && terms.length < 64; index += 1) {
      addFtsTerm(terms, seen, characters.slice(index, index + 3).join(""));
    }
  }
  return terms.length === 0 ? null : terms.map(quoteFtsTerm).join(" OR ");
}

function addFtsTerm(target: string[], seen: Set<string>, term: string): void {
  if (!seen.has(term)) {
    seen.add(term);
    target.push(term);
  }
}

function quoteFtsTerm(term: string): string {
  return `"${term.replaceAll('"', '""')}"`;
}

function mapSearchResult(row: SearchRow): RetrievedChunk {
  return {
    chunkId: row.chunk_id,
    sourceId: row.source_id,
    content: row.content,
    startOffset: Number(row.start_offset),
    endOffset: Number(row.end_offset),
    sourceTitle: row.source_title,
    sourceRevision: row.source_revision,
    sourceUpdatedAt: row.source_updated_at,
  };
}

function validateSearch(filter: KnowledgeSearchFilter, limit: number): void {
  if (filter.projectId.trim() === "" || filter.sourceType !== "material") {
    throw new AppError("VALIDATION_ERROR", "资料检索缺少有效的项目或资料类型范围。");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new AppError("VALIDATION_ERROR", "检索结果数量必须为 1–100。");
  }
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}
