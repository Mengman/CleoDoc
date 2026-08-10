import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { TEST_DATABASE_OPTIONS } from "../../../test/runtime-options.js";
import { KnowledgeChunkRepository } from "./knowledge-chunk-repository.js";
import { KnowledgeContextRepository } from "./knowledge-context-repository.js";
import { ProjectDatabase } from "./project-database.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("KnowledgeContextRepository", () => {
  it("reads bounded neighboring chunks in source order and always includes the target", async () => {
    const database = await createDatabase();
    try {
      const chunks = await seedSource(database, "project-1", "source-1", "资料一");
      const result = new KnowledgeContextRepository(database).read(
        "project-1",
        "source-1",
        chunks[1]!.chunkId,
        1,
        1,
      );

      expect(result).toEqual({
        sourceId: "source-1",
        sourceTitle: "资料一",
        targetChunkId: chunks[1]!.chunkId,
        chunks: chunks.map((chunk) => ({ chunkId: chunk.chunkId, content: chunk.content })),
      });
      expect(
        new KnowledgeContextRepository(database).read(
          "project-1",
          "source-1",
          chunks[1]!.chunkId,
          0,
          0,
        ).chunks,
      ).toEqual([{ chunkId: chunks[1]!.chunkId, content: chunks[1]!.content }]);
    } finally {
      await database.close();
    }
  });

  it("does not reveal chunks from another project and detects a source mismatch", async () => {
    const database = await createDatabase();
    try {
      const first = await seedSource(database, "project-1", "source-1", "资料一");
      const second = await seedSource(database, "project-1", "source-2", "资料二");
      const repository = new KnowledgeContextRepository(database);

      expect(() => repository.read("project-2", "source-1", first[0]!.chunkId, 0, 0)).toThrow(
        expect.objectContaining({ code: "MATERIAL_NOT_FOUND" }),
      );
      expect(() => repository.read("project-1", "source-1", second[0]!.chunkId, 0, 0)).toThrow(
        expect.objectContaining({ code: "CHUNK_SOURCE_MISMATCH" }),
      );
    } finally {
      await database.close();
    }
  });
});

async function createDatabase(): Promise<ProjectDatabase> {
  const root = await mkdtemp(path.join(tmpdir(), "cleodoc-knowledge-context-test-"));
  temporaryDirectories.push(root);
  return await ProjectDatabase.open(root, TEST_DATABASE_OPTIONS);
}

async function seedSource(
  database: ProjectDatabase,
  projectId: string,
  sourceId: string,
  title: string,
) {
  const now = "2026-01-01T00:00:00.000Z";
  const sourceHash = sourceId.padEnd(64, "0").slice(0, 64);
  await database.write((sqlite) => {
    sqlite
      .prepare(
        `INSERT INTO sources
         (id, project_id, source_type, origin, format, title, languages_json,
          relative_path, content_hash, size, created_at, updated_at)
         VALUES (?, ?, 'material', 'paste', 'text', ?, '["zh"]', ?, ?, 100, ?, ?)`,
      )
      .run(sourceId, projectId, title, `materials/${sourceId}.txt`, sourceHash, now, now);
  });
  return await new KnowledgeChunkRepository(database).replaceForSource({
    sourceId,
    expectedContentHash: sourceHash,
    parserVersion: "test-parser",
    chunkerVersion: "test-chunker",
    chunkingConfigJson: "{}",
    chunks: [
      { ordinal: 0, content: "第一段", startOffset: 0, endOffset: 9 },
      { ordinal: 1, content: "第二段", startOffset: 9, endOffset: 18 },
      { ordinal: 2, content: "第三段", startOffset: 18, endOffset: 27 },
    ],
  });
}
