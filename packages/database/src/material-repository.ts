import type { KnowledgeSource } from "../../contracts/src/index.js";
import { AppError } from "../../contracts/src/index.js";
import type { ProjectDatabase } from "./project-database.js";

interface SourceRow {
  id: string;
  project_id: string;
  source_type: "material";
  origin: KnowledgeSource["origin"];
  format: KnowledgeSource["format"];
  title: string;
  source_label: string | null;
  original_file_name: string | null;
  tags_json: string;
  relative_path: string;
  content_hash: string;
  size: number;
  created_at: string;
  updated_at: string;
}

export class MaterialRepository {
  constructor(private readonly projectDatabase: ProjectDatabase) {}

  list(): KnowledgeSource[] {
    const rows = this.projectDatabase.read(
      (database) =>
        database
          .prepare("SELECT * FROM sources WHERE source_type = 'material' ORDER BY updated_at DESC")
          .all() as unknown as SourceRow[],
    );
    return rows.map(mapSource);
  }

  get(id: string): KnowledgeSource | null {
    const row = this.projectDatabase.read(
      (database) =>
        database
          .prepare("SELECT * FROM sources WHERE id = ? AND source_type = 'material'")
          .get(id) as SourceRow | undefined,
    );
    return row === undefined ? null : mapSource(row);
  }

  findByContentHash(contentHash: string): KnowledgeSource | null {
    const row = this.projectDatabase.read(
      (database) =>
        database
          .prepare("SELECT * FROM sources WHERE content_hash = ? AND source_type = 'material'")
          .get(contentHash) as SourceRow | undefined,
    );
    return row === undefined ? null : mapSource(row);
  }

  async upsert(source: KnowledgeSource): Promise<void> {
    await this.projectDatabase.write((database) => {
      database
        .prepare(
          `INSERT INTO sources
           (id, project_id, source_type, origin, format, title, source_label,
            original_file_name, tags_json, relative_path, content_hash, size, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             project_id = excluded.project_id,
             source_type = excluded.source_type,
             origin = excluded.origin,
             format = excluded.format,
             title = excluded.title,
             source_label = excluded.source_label,
             original_file_name = excluded.original_file_name,
             tags_json = excluded.tags_json,
             relative_path = excluded.relative_path,
             content_hash = excluded.content_hash,
             size = excluded.size,
             parser_version = CASE WHEN sources.content_hash = excluded.content_hash
               THEN sources.parser_version ELSE NULL END,
             chunker_version = CASE WHEN sources.content_hash = excluded.content_hash
               THEN sources.chunker_version ELSE NULL END,
             chunking_config_json = CASE WHEN sources.content_hash = excluded.content_hash
               THEN sources.chunking_config_json ELSE NULL END,
             index_status = CASE WHEN sources.content_hash = excluded.content_hash
               THEN sources.index_status ELSE 'stale' END,
             index_error_code = CASE WHEN sources.content_hash = excluded.content_hash
               THEN sources.index_error_code ELSE NULL END,
             indexed_at = CASE WHEN sources.content_hash = excluded.content_hash
               THEN sources.indexed_at ELSE NULL END,
             created_at = excluded.created_at,
             updated_at = excluded.updated_at`,
        )
        .run(
          source.id,
          source.projectId,
          source.type,
          source.origin,
          source.format,
          source.title,
          source.sourceLabel,
          source.originalFileName,
          JSON.stringify(source.tags),
          source.relativePath,
          source.contentHash,
          source.size,
          source.createdAt,
          source.updatedAt,
        );
    });
  }

  async remove(id: string): Promise<void> {
    await this.projectDatabase.write((database) => {
      database.prepare("DELETE FROM sources WHERE id = ? AND source_type = 'material'").run(id);
    });
  }

  async synchronize(sources: readonly KnowledgeSource[]): Promise<void> {
    await this.projectDatabase.transaction((database) => {
      const ids = new Set(sources.map((source) => source.id));
      const existing = database
        .prepare("SELECT id FROM sources WHERE source_type = 'material'")
        .all() as Array<{ id: string }>;
      const remove = database.prepare(
        "DELETE FROM sources WHERE id = ? AND source_type = 'material'",
      );
      for (const row of existing) {
        if (!ids.has(row.id)) {
          remove.run(row.id);
        }
      }

      const upsert = database.prepare(
        `INSERT INTO sources
         (id, project_id, source_type, origin, format, title, source_label,
          original_file_name, tags_json, relative_path, content_hash, size, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           project_id = excluded.project_id,
           source_type = excluded.source_type,
           origin = excluded.origin,
           format = excluded.format,
           title = excluded.title,
           source_label = excluded.source_label,
           original_file_name = excluded.original_file_name,
           tags_json = excluded.tags_json,
           relative_path = excluded.relative_path,
           content_hash = excluded.content_hash,
           size = excluded.size,
           parser_version = CASE WHEN sources.content_hash = excluded.content_hash
             THEN sources.parser_version ELSE NULL END,
           chunker_version = CASE WHEN sources.content_hash = excluded.content_hash
             THEN sources.chunker_version ELSE NULL END,
           chunking_config_json = CASE WHEN sources.content_hash = excluded.content_hash
             THEN sources.chunking_config_json ELSE NULL END,
           index_status = CASE WHEN sources.content_hash = excluded.content_hash
             THEN sources.index_status ELSE 'stale' END,
           index_error_code = CASE WHEN sources.content_hash = excluded.content_hash
             THEN sources.index_error_code ELSE NULL END,
           indexed_at = CASE WHEN sources.content_hash = excluded.content_hash
             THEN sources.indexed_at ELSE NULL END,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at`,
      );
      for (const source of sources) {
        upsert.run(
          source.id,
          source.projectId,
          source.type,
          source.origin,
          source.format,
          source.title,
          source.sourceLabel,
          source.originalFileName,
          JSON.stringify(source.tags),
          source.relativePath,
          source.contentHash,
          source.size,
          source.createdAt,
          source.updatedAt,
        );
      }
    });
  }
}

function mapSource(row: SourceRow): KnowledgeSource {
  let tags: unknown;
  try {
    tags = JSON.parse(row.tags_json) as unknown;
  } catch (error) {
    throw new AppError("DATABASE_ERROR", "资料标签投影格式无效。", { cause: error });
  }
  if (!Array.isArray(tags) || !tags.every((tag) => typeof tag === "string")) {
    throw new AppError("DATABASE_ERROR", "资料标签投影格式无效。");
  }
  return {
    schemaVersion: 1,
    id: row.id,
    projectId: row.project_id,
    type: row.source_type,
    origin: row.origin,
    format: row.format,
    title: row.title,
    sourceLabel: row.source_label,
    originalFileName: row.original_file_name,
    tags,
    relativePath: row.relative_path,
    contentHash: row.content_hash,
    size: Number(row.size),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
