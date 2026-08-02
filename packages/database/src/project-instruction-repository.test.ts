import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ProjectDatabase } from "./project-database.js";
import { ProjectInstructionRepository } from "./project-instruction-repository.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("ProjectInstructionRepository", () => {
  it("creates complete revisions for set, append, replacement, and restore", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cleodoc-instructions-test-"));
    temporaryDirectories.push(root);
    const database = await ProjectDatabase.open(root);
    const repository = new ProjectInstructionRepository(database);
    try {
      expect(repository.getCurrent()).toBeNull();
      const first = await repository.set("第一条规则", 0);
      const second = await repository.append("\n第二条规则", first.revision);
      const third = await repository.replaceText("第二条规则", "修订后的规则", second.revision);
      const restored = await repository.restore(first.revision, third.revision);

      expect(second.content).toBe("第一条规则\n第二条规则");
      expect(third.content).toBe("第一条规则\n修订后的规则");
      expect(restored.content).toBe(first.content);
      expect(repository.list().map((item) => item.revision)).toEqual([
        restored.revision,
        third.revision,
        second.revision,
        first.revision,
      ]);
    } finally {
      await database.close();
    }
  });

  it("rejects stale revisions without changing current content", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cleodoc-instructions-conflict-test-"));
    temporaryDirectories.push(root);
    const database = await ProjectDatabase.open(root);
    const repository = new ProjectInstructionRepository(database);
    try {
      const first = await repository.set("初始规则", 0);
      await repository.set("用户的新规则", first.revision);
      await expect(repository.append("过期修改", first.revision)).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
        details: { expectedRevision: first.revision },
      });
      expect(repository.getCurrent()?.content).toBe("用户的新规则");
    } finally {
      await database.close();
    }
  });
});
