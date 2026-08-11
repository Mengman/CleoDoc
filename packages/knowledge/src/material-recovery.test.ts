import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ProjectDatabase } from "../../database/src/index.js";
import { ProjectService } from "../../project/src/index.js";
import { TEST_DATABASE_OPTIONS, TEST_MATERIAL_OPTIONS } from "../../../test/runtime-options.js";
import { MaterialService } from "./material-service.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("MaterialService projection recovery", () => {
  it("restores imported-file projections from metadata after the database is rebuilt", async () => {
    const directory = await createTemporaryDirectory();
    const project = await new ProjectService(TEST_DATABASE_OPTIONS).create(
      path.join(directory, "novel.cleo"),
    );
    const inputPath = path.join(directory, "railway-notes.md");
    await writeFile(inputPath, "# Railway notes\n\nThe night train uses an oil lamp.\n", "utf8");

    const initial = await MaterialService.open(project.root, TEST_MATERIAL_OPTIONS);
    const imported = await initial.addFile(inputPath, { title: "Railway Notes" });
    await initial.close();

    await rm(path.join(project.root, ".cleo", "project.sqlite"), { force: true });

    const recovered = await MaterialService.open(project.root, TEST_MATERIAL_OPTIONS);
    try {
      expect(await recovered.list()).toEqual([imported.source]);
      expect(
        await readFile(path.join(project.root, imported.source.relativePath), "utf8"),
      ).toContain("night train");
    } finally {
      await recovered.close();
    }
  });

  it("calibrates swapped projection titles without deleting existing chunks", async () => {
    const directory = await createTemporaryDirectory();
    const project = await new ProjectService(TEST_DATABASE_OPTIONS).create(
      path.join(directory, "novel.cleo"),
    );
    const initial = await MaterialService.open(project.root, TEST_MATERIAL_OPTIONS);
    const alpha = await initial.addText("Alpha evidence is stored in the clock tower.", {
      title: "Alpha Notes",
    });
    const beta = await initial.addText("Beta evidence is stored in the railway station.", {
      title: "Beta Notes",
    });
    await initial.close();

    const database = await ProjectDatabase.open(project.root, TEST_DATABASE_OPTIONS);
    const chunkCount = database.read(
      (sqlite) =>
        (
          sqlite.prepare("SELECT COUNT(*) AS count FROM knowledge_chunks").get() as {
            count: number;
          }
        ).count,
    );
    await database.transaction((sqlite) => {
      sqlite.prepare("UPDATE sources SET title = ? WHERE id = ?").run("temporary", alpha.source.id);
      sqlite
        .prepare("UPDATE sources SET title = ? WHERE id = ?")
        .run(alpha.source.title, beta.source.id);
      sqlite
        .prepare("UPDATE sources SET title = ? WHERE id = ?")
        .run(beta.source.title, alpha.source.id);
    });
    await database.close();

    const calibrated = await MaterialService.open(project.root, TEST_MATERIAL_OPTIONS);
    try {
      const sources = await calibrated.list();
      expect(sources.find((source) => source.id === alpha.source.id)?.title).toBe("Alpha Notes");
      expect(sources.find((source) => source.id === beta.source.id)?.title).toBe("Beta Notes");
      const reopenedDatabase = await ProjectDatabase.open(project.root, TEST_DATABASE_OPTIONS);
      try {
        expect(
          reopenedDatabase.read(
            (sqlite) =>
              (
                sqlite.prepare("SELECT COUNT(*) AS count FROM knowledge_chunks").get() as {
                  count: number;
                }
              ).count,
          ),
        ).toBe(chunkCount);
      } finally {
        await reopenedDatabase.close();
      }
    } finally {
      await calibrated.close();
    }
  });
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "cleodoc-material-recovery-test-"));
  temporaryDirectories.push(directory);
  return directory;
}
