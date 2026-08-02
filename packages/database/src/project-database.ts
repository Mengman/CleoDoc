import { copyFileSync, mkdirSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { AppError } from "../../contracts/src/index.js";
import { migrations } from "./migrations.js";

type DatabaseOperation<T> = (database: DatabaseSync) => T;

export class ProjectDatabase {
  readonly filePath: string;
  private readonly database: DatabaseSync;
  private writeTail: Promise<void> = Promise.resolve();
  private closed = false;

  private constructor(filePath: string, database: DatabaseSync) {
    this.filePath = filePath;
    this.database = database;
  }

  static async open(projectRoot: string): Promise<ProjectDatabase> {
    const stateDirectory = path.join(projectRoot, ".cleo");
    await mkdir(stateDirectory, { recursive: true });
    const filePath = path.join(stateDirectory, "project.sqlite");

    try {
      const database = new DatabaseSync(filePath);
      const instance = new ProjectDatabase(filePath, database);
      instance.configure();
      instance.migrate();
      return instance;
    } catch (error) {
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
    this.database.exec("PRAGMA busy_timeout = 5000");
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      )
    `);

    const appliedRows = this.database
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all() as Array<{ version: number }>;
    const applied = new Set(appliedRows.map((row) => Number(row.version)));
    const insert = this.database.prepare(
      "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)",
    );
    const pending = migrations.filter((migration) => !applied.has(migration.version));
    if (applied.size > 0 && pending.length > 0) {
      this.backupBeforeMigration(pending[0]!.version);
    }

    for (const migration of pending) {
      this.database.exec("BEGIN IMMEDIATE");
      try {
        if (migration.sql !== "") this.database.exec(migration.sql);
        migration.apply?.(this.database);
        insert.run(migration.version as SQLInputValue, new Date().toISOString());
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }
  }

  private backupBeforeMigration(targetVersion: number): void {
    this.database.exec("PRAGMA wal_checkpoint(FULL)");
    const backupDirectory = path.join(path.dirname(this.filePath), "backups");
    mkdirSync(backupDirectory, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const destination = path.join(
      backupDirectory,
      `pre-migration-v${targetVersion}-${timestamp}.sqlite`,
    );
    copyFileSync(this.filePath, destination, 0);
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new AppError("DATABASE_ERROR", "项目数据库已经关闭。");
    }
  }
}
