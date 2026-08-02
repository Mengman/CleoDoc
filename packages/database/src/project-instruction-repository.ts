import { createHash } from "node:crypto";

import type { ProjectInstructionRevision } from "../../contracts/src/index.js";
import { AppError } from "../../contracts/src/index.js";
import type { ProjectDatabase } from "./project-database.js";

const MAX_PROJECT_INSTRUCTIONS_BYTES = 64 * 1024;

interface RevisionRow {
  revision: number;
  content: string;
  content_hash: string;
  created_at: string;
}

export class ProjectInstructionRepository {
  constructor(private readonly projectDatabase: ProjectDatabase) {}

  getCurrent(): ProjectInstructionRevision | null {
    const row = this.projectDatabase.read(
      (database) =>
        database
          .prepare(
            `SELECT revision, content, content_hash, created_at
             FROM project_instruction_revisions ORDER BY revision DESC LIMIT 1`,
          )
          .get() as RevisionRow | undefined,
    );
    return row === undefined ? null : mapRevision(row);
  }

  getRevision(revision: number): ProjectInstructionRevision | null {
    const row = this.projectDatabase.read(
      (database) =>
        database
          .prepare(
            `SELECT revision, content, content_hash, created_at
             FROM project_instruction_revisions WHERE revision = ?`,
          )
          .get(revision) as RevisionRow | undefined,
    );
    return row === undefined ? null : mapRevision(row);
  }

  list(limit = 50): ProjectInstructionRevision[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new AppError("VALIDATION_ERROR", "项目指令历史数量必须在 1 到 500 之间。");
    }
    return this.projectDatabase
      .read(
        (database) =>
          database
            .prepare(
              `SELECT revision, content, content_hash, created_at
               FROM project_instruction_revisions ORDER BY revision DESC LIMIT ?`,
            )
            .all(limit) as unknown as RevisionRow[],
      )
      .map(mapRevision);
  }

  async set(content: string, expectedRevision: number): Promise<ProjectInstructionRevision> {
    validateContent(content);
    validateExpectedRevision(expectedRevision);
    const contentHash = hashContent(content);
    const createdAt = new Date().toISOString();
    return this.projectDatabase.transaction((database) => {
      const current = database
        .prepare(
          `SELECT revision, content, content_hash, created_at
           FROM project_instruction_revisions ORDER BY revision DESC LIMIT 1`,
        )
        .get() as RevisionRow | undefined;
      const currentRevision = current === undefined ? 0 : Number(current.revision);
      if (currentRevision !== expectedRevision) {
        throw new AppError("VALIDATION_ERROR", "项目指令已被其他操作更新，请重新读取后再修改。", {
          details: { expectedRevision, currentRevision },
        });
      }
      const result = database
        .prepare(
          `INSERT INTO project_instruction_revisions(content, content_hash, created_at)
           VALUES (?, ?, ?)`,
        )
        .run(content, contentHash, createdAt);
      return {
        revision: Number(result.lastInsertRowid),
        content,
        contentHash,
        createdAt,
      };
    });
  }

  async append(text: string, expectedRevision: number): Promise<ProjectInstructionRevision> {
    const current = this.requireExpectedCurrent(expectedRevision);
    return this.set(`${current?.content ?? ""}${text}`, expectedRevision);
  }

  async replaceText(
    oldText: string,
    newText: string,
    expectedRevision: number,
  ): Promise<ProjectInstructionRevision> {
    if (oldText === "") {
      throw new AppError("VALIDATION_ERROR", "被替换的项目指令文本不能为空。");
    }
    const current = this.requireExpectedCurrent(expectedRevision);
    if (current === null) {
      throw new AppError("VALIDATION_ERROR", "项目尚未设置指令，无法执行局部替换。");
    }
    const first = current.content.indexOf(oldText);
    if (first < 0) {
      throw new AppError("VALIDATION_ERROR", "当前项目指令中不存在指定的旧文本。");
    }
    if (current.content.indexOf(oldText, first + oldText.length) >= 0) {
      throw new AppError(
        "VALIDATION_ERROR",
        "指定旧文本在项目指令中出现多次，请提供更精确的文本或使用全量更新。",
      );
    }
    const content = `${current.content.slice(0, first)}${newText}${current.content.slice(first + oldText.length)}`;
    return this.set(content, expectedRevision);
  }

  async restore(revision: number, expectedRevision: number): Promise<ProjectInstructionRevision> {
    const target = this.getRevision(revision);
    if (target === null) {
      throw new AppError("VALIDATION_ERROR", `找不到项目指令 Revision ${revision}。`);
    }
    return this.set(target.content, expectedRevision);
  }

  private requireExpectedCurrent(expectedRevision: number): ProjectInstructionRevision | null {
    validateExpectedRevision(expectedRevision);
    const current = this.getCurrent();
    const currentRevision = current?.revision ?? 0;
    if (currentRevision !== expectedRevision) {
      throw new AppError("VALIDATION_ERROR", "项目指令已被其他操作更新，请重新读取后再修改。", {
        details: { expectedRevision, currentRevision },
      });
    }
    return current;
  }
}

export function hashProjectInstructions(content: string): string {
  return hashContent(content);
}

function validateExpectedRevision(revision: number): void {
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new AppError("VALIDATION_ERROR", "expected_revision 必须是非负整数。");
  }
}

function validateContent(content: string): void {
  if (Buffer.byteLength(content, "utf8") > MAX_PROJECT_INSTRUCTIONS_BYTES) {
    throw new AppError("VALIDATION_ERROR", "项目指令超过 64 KiB，无法保存或注入模型上下文。");
  }
}

function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function mapRevision(row: RevisionRow): ProjectInstructionRevision {
  return {
    revision: Number(row.revision),
    content: row.content,
    contentHash: row.content_hash,
    createdAt: row.created_at,
  };
}
