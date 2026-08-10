import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ProjectDatabase } from "./project-database.js";
import { TEST_DATABASE_OPTIONS } from "../../../test/runtime-options.js";
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
  it("rejects stale revisions without changing current content", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cleodoc-instructions-conflict-test-"));
    temporaryDirectories.push(root);
    const database = await ProjectDatabase.open(root, TEST_DATABASE_OPTIONS);
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
