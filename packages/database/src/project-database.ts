import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { AppError } from "../../contracts/src/index.js";
import { CURRENT_SCHEMA_SQL, CURRENT_SCHEMA_VERSION } from "./current-schema.js";
import { SCHEMA_V8_TO_V9_SQL, SCHEMA_V9_TO_V10_SQL } from "./schema-migrations.js";

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
      database = new DatabaseSync(filePath);
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
    this.database.exec("PRAGMA foreign_keys = ON");
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA synchronous = FULL");
    this.database.exec(`PRAGMA busy_timeout = ${this.busyTimeoutMs}`);
  }

  private initializeSchema(): void {
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
    if (appliedVersions.includes(CURRENT_SCHEMA_VERSION)) return;

    if (newestVersion === 8 && CURRENT_SCHEMA_VERSION === 10) {
      this.applyMigration(SCHEMA_V8_TO_V9_SQL, 9);
      this.applyMigration(SCHEMA_V9_TO_V10_SQL, 10);
      return;
    }
    if (newestVersion === 9 && CURRENT_SCHEMA_VERSION === 10) {
      this.applyMigration(SCHEMA_V9_TO_V10_SQL, 10);
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

  private assertOpen(): void {
    if (this.closed) {
      throw new AppError("DATABASE_ERROR", "项目数据库已经关闭。");
    }
  }
}
