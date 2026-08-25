import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { AppError } from "../../contracts/src/index.js";
import { CURRENT_SCHEMA_SQL, CURRENT_SCHEMA_VERSION } from "./current-schema.js";
import {
  SCHEMA_V10_TO_V11_SQL,
  SCHEMA_V11_TO_V12_SQL,
  SCHEMA_V8_TO_V9_SQL,
  SCHEMA_V9_TO_V10_SQL,
} from "./schema-migrations.js";

type DatabaseOperation<T> = (database: DatabaseSync) => T;

export class ProjectDatabase {
  readonly filePath: string;
  private readonly database: DatabaseSync;
  private writeTail: Promise<void> = Promise.resolve();
  private closed = false;

  private constructor(
    filePath: string,
    database: DatabaseSync,
    private readonly busyTimeoutMs: number,
  ) {
    this.filePath = filePath;
    this.database = database;
  }

  static async open(
    projectRoot: string,
    options: { busyTimeoutMs: number },
  ): Promise<ProjectDatabase> {
    const stateDirectory = path.join(projectRoot, ".cleo");
    await mkdir(stateDirectory, { recursive: true });
    const filePath = path.join(stateDirectory, "project.sqlite");

    let database: DatabaseSync | undefined;
    try {
      database = new DatabaseSync(filePath, { allowExtension: true });
      const instance = new ProjectDatabase(filePath, database, options.busyTimeoutMs);
      instance.configure();
      instance.initializeSchema();
      return instance;
    } catch (error) {
      try {
        database?.close();
      } catch {
        // Preserve the original open/schema error.
      }
      if (error instanceof AppError) throw error;
      throw new AppError("DATABASE_ERROR", "无法打开项目数据库。", { cause: error });
    }
  }

  read<T>(operation: DatabaseOperation<T>): T {
    this.assertOpen();
    return operation(this.database);
  }

  async write<T>(operation: DatabaseOperation<T>): Promise<T> {
    this.assertOpen();
    const pending = this.writeTail.then(() => operation(this.database));
    this.writeTail = pending.then(
      () => undefined,
      () => undefined,
    );

    try {
      return await pending;
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError("DATABASE_ERROR", "项目数据库写入失败。", { cause: error });
    }
  }

  async transaction<T>(operation: DatabaseOperation<T>): Promise<T> {
    return this.write((database) => {
      database.exec("BEGIN IMMEDIATE");
      try {
        const result = operation(database);
        database.exec("COMMIT");
        return result;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    });
  }

  quickCheck(): boolean {
    try {
      const row = this.database.prepare("PRAGMA quick_check").get() as
        Record<string, unknown> | undefined;
      return row !== undefined && Object.values(row)[0] === "ok";
    } catch {
      return false;
    }
  }

  async backup(): Promise<string> {
    this.assertOpen();
    await this.write((database) => database.exec("PRAGMA wal_checkpoint(FULL)"));
    const backupDirectory = path.join(path.dirname(this.filePath), "backups");
    await mkdir(backupDirectory, { recursive: true });
    const timestamp = new Date().toISOString().replaceAll(":", "-");
    const destination = path.join(backupDirectory, `project-${timestamp}.sqlite`);
    await copyFile(this.filePath, destination);
    return destination;
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    await this.writeTail;
    this.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    this.database.close();
    this.closed = true;
  }

  private configure(): void {
    this.database.enableLoadExtension(false);
    this.database.exec("PRAGMA foreign_keys = ON");
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA synchronous = FULL");
    this.database.exec(`PRAGMA busy_timeout = ${this.busyTimeoutMs}`);
  }

  private initializeSchema(): void {
    // Create or migrate the project database to the single supported current schema.
    // 1. Read the ordered migration history and reject unsupported future versions.
    // 2. Apply every supported forward migration needed by complete v8-v11 databases.
    // 3. Reject unversioned or obsolete databases that already contain application data.
    // 4. Install the complete v12 baseline for a new empty project database.
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      )
    `);

    const appliedRows = this.database
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all() as Array<{ version: number }>;
    const appliedVersions = appliedRows.map((row) => Number(row.version));
    const newestVersion = appliedVersions.at(-1) ?? null;
    if (newestVersion !== null && newestVersion > CURRENT_SCHEMA_VERSION) {
      throw new AppError(
        "DATABASE_ERROR",
        `项目数据库版本 v${newestVersion} 高于当前程序支持的 v${CURRENT_SCHEMA_VERSION}。`,
      );
    }
    if (appliedVersions.includes(CURRENT_SCHEMA_VERSION)) {
      return;
    }

    if (newestVersion === 8 && CURRENT_SCHEMA_VERSION === 12) {
      this.applyMigration(SCHEMA_V8_TO_V9_SQL, 9);
      this.applyV9ToV10Migration();
      this.applyV10ToV11Migration();
      this.applyMigration(SCHEMA_V11_TO_V12_SQL, 12);
      return;
    }

    if (newestVersion === 9 && CURRENT_SCHEMA_VERSION === 12) {
      this.removeObsoleteSourceTagsColumn();
      this.applyV9ToV10Migration();
      this.applyV10ToV11Migration();
      this.applyMigration(SCHEMA_V11_TO_V12_SQL, 12);
      return;
    }

    if (newestVersion === 10 && CURRENT_SCHEMA_VERSION === 12) {
      this.applyV10ToV11Migration();
      this.applyMigration(SCHEMA_V11_TO_V12_SQL, 12);
      return;
    }

    if (newestVersion === 11 && CURRENT_SCHEMA_VERSION === 12) {
      this.applyMigration(SCHEMA_V11_TO_V12_SQL, 12);
      return;
    }

    const applicationObject = this.database
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations'
         LIMIT 1`,
      )
      .get() as { name: string } | undefined;
    if (newestVersion !== null || applicationObject !== undefined) {
      throw new AppError(
        "DATABASE_ERROR",
        `项目数据库仍是已停止支持的开发期版本${
          newestVersion === null ? "" : ` v${newestVersion}`
        }；当前只支持完整 v${CURRENT_SCHEMA_VERSION} 数据库。请重建项目数据库。`,
      );
    }

    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.exec(CURRENT_SCHEMA_SQL);
      this.database
        .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
        .run(CURRENT_SCHEMA_VERSION, new Date().toISOString());
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private applyMigration(sql: string, version: number): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.exec(sql);
      this.database
        .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
        .run(version, new Date().toISOString());
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private removeObsoleteSourceTagsColumn(): void {
    const columns = this.database.prepare("PRAGMA table_info(sources)").all() as Array<{
      name: string;
    }>;
    if (!columns.some((column) => column.name === "tags_json")) return;

    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.exec("ALTER TABLE sources DROP COLUMN tags_json");
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private applyV9ToV10Migration(): void {
    const duplicate = this.database
      .prepare(
        `SELECT title FROM sources
         GROUP BY title
         HAVING COUNT(*) > 1
         LIMIT 1`,
      )
      .get() as { title: string } | undefined;
    if (duplicate !== undefined) {
      throw new AppError(
        "DATABASE_ERROR",
        `项目数据库中存在同名资料“${duplicate.title}”，无法升级到 v10。请先使用旧版 CleoDoc 重命名重复资料。`,
      );
    }
    this.applyMigration(SCHEMA_V9_TO_V10_SQL, 10);
  }

  private applyV10ToV11Migration(): void {
    // Rebuild the four coupled tables while preserving all child rows and verified summaries.
    // 1. Reject ambiguous or missing Summary-to-Job relationships before changing data.
    // 2. Disable immediate foreign-key enforcement and rebuild all affected parent tables atomically.
    // 3. Run a complete foreign-key check before committing and restore enforcement afterwards.
    const invalidSummary = this.database
      .prepare(
        `SELECT jobs.id
         FROM compaction_jobs jobs
         LEFT JOIN session_summaries summaries ON summaries.id = jobs.summary_id
         WHERE (jobs.status = 'completed' AND summaries.id IS NULL)
            OR (jobs.status <> 'completed' AND jobs.summary_id IS NOT NULL)
            OR (summaries.id IS NOT NULL AND summaries.source_session_id <> jobs.source_session_id)
            OR (summaries.id IS NOT NULL AND summaries.conversation_id <> jobs.conversation_id)
         LIMIT 1`,
      )
      .get() as { id: string } | undefined;
    const ambiguousSummary = this.database
      .prepare(
        `SELECT summary_id
         FROM compaction_jobs
         WHERE summary_id IS NOT NULL
         GROUP BY summary_id HAVING COUNT(*) > 1
         LIMIT 1`,
      )
      .get() as { summary_id: string } | undefined;
    const orphanSummary = this.database
      .prepare(
        `SELECT summaries.id
         FROM session_summaries summaries
         LEFT JOIN compaction_jobs jobs ON jobs.summary_id = summaries.id
         WHERE jobs.id IS NULL
         LIMIT 1`,
      )
      .get() as { id: string } | undefined;
    const missingInheritedJob = this.database
      .prepare(
        `SELECT sessions.id
         FROM conversation_sessions sessions
         LEFT JOIN compaction_jobs jobs ON jobs.summary_id = sessions.inherited_summary_id
         WHERE sessions.inherited_summary_id IS NOT NULL AND jobs.id IS NULL
         LIMIT 1`,
      )
      .get() as { id: string } | undefined;
    if (
      invalidSummary !== undefined ||
      ambiguousSummary !== undefined ||
      orphanSummary !== undefined ||
      missingInheritedJob !== undefined
    ) {
      throw new AppError(
        "DATABASE_ERROR",
        "The v10 compaction summaries cannot be mapped uniquely to v11 jobs.",
      );
    }

    this.database.exec("PRAGMA foreign_keys = OFF");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.exec(SCHEMA_V10_TO_V11_SQL);
      const violations = this.database.prepare("PRAGMA foreign_key_check").all();
      if (violations.length > 0) {
        throw new AppError("DATABASE_ERROR", "The v11 database migration violates foreign keys.");
      }
      this.database
        .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
        .run(11, new Date().toISOString());
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    } finally {
      this.database.exec("PRAGMA foreign_keys = ON");
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new AppError("DATABASE_ERROR", "项目数据库已经关闭。");
    }
  }
}
