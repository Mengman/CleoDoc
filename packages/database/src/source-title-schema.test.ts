import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { KnowledgeSource } from "../../contracts/src/index.js";
import { ProjectService } from "../../project/src/index.js";
import { TEST_DATABASE_OPTIONS } from "../../../test/runtime-options.js";
import { MaterialRepository } from "./material-repository.js";
import { ProjectDatabase } from "./project-database.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("sources title schema", () => {
  it("creates the v10 unique title index", async () => {
    const root = await createTemporaryDirectory();
    const project = await new ProjectService(TEST_DATABASE_OPTIONS).create(
      path.join(root, "novel.cleo"),
    );
    const database = await ProjectDatabase.open(project.root, TEST_DATABASE_OPTIONS);
    try {
      expect(
        database.read(
          (sqlite) =>
            sqlite
              .prepare(
                "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'sources_title_unique'",
              )
              .get() as { name: string } | undefined,
        ),
      ).toEqual({ name: "sources_title_unique" });

      const repository = new MaterialRepository(database);
      await repository.upsert(source(project.manifest.id, "source-a", "同名资料", "a.txt", "a"));
      await expect(
        repository.upsert(source(project.manifest.id, "source-b", "同名资料", "b.txt", "b")),
      ).rejects.toMatchObject({ code: "DATABASE_ERROR" });
    } finally {
      await database.close();
    }
  });
});

function source(
  projectId: string,
  id: string,
  title: string,
  fileName: string,
  hashSeed: string,
): KnowledgeSource {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    id: `00000000-0000-4000-8000-${id === "source-a" ? "000000000001" : "000000000002"}`,
    projectId,
    type: "material",
    origin: "file",
    format: "text",
    title,
    originalFileName: fileName,
    languages: ["zh"],
    relativePath: `materials/${fileName}`,
    contentHash: hashSeed.repeat(64),
    size: 1,
    createdAt: now,
    updatedAt: now,
  };
}

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "cleodoc-source-title-schema-test-"));
  temporaryDirectories.push(directory);
  return directory;
}
