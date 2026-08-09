import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { TEST_DATABASE_OPTIONS } from "../../../test/runtime-options.js";
import { KnowledgeChunkRepository } from "./knowledge-chunk-repository.js";
import { ProjectDatabase } from "./project-database.js";

const temporaryDirectories: string[] = [];
const SOURCE_HASH = "0".repeat(64);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("KnowledgeChunkRepository", () => {
  it("keeps stable rows incrementally and invalidates only changed embeddings", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cleodoc-chunk-repository-test-"));
    temporaryDirectories.push(root);
    const database = await ProjectDatabase.open(root, TEST_DATABASE_OPTIONS);
    const repository = new KnowledgeChunkRepository(database);

    try {
      await insertSource(database);
      const initialChunks = [
        { ordinal: 0, content: "alpha", startOffset: 0, endOffset: 5 },
        { ordinal: 1, content: "beta", startOffset: 6, endOffset: 10 },
      ] as const;
      await replace(repository, initialChunks);
      const initialRows = readChunkRows(database);

      await database.write((sqlite) => {
        sqlite
          .prepare(
            `INSERT INTO embedding_models
             (model_name, revision, created_at)
             VALUES ('test-model', 'v1', '2026-01-01T00:00:00.000Z')`,
          )
          .run();
        const insert = sqlite.prepare(
          `INSERT INTO chunk_embeddings
           (embedding_model_rowid, chunk_rowid, content_hash, embedding, created_at)
           VALUES ((SELECT embedding_model_rowid FROM embedding_models), ?, ?, ?,
                   '2026-01-01T00:00:00.000Z')`,
        );
        for (const row of initialRows) {
          insert.run(row.chunk_rowid, row.content_hash, Buffer.alloc(4, 1));
        }
      });

      await replace(repository, initialChunks);
      expect(readChunkRows(database)).toEqual(initialRows);
      expect(countEmbeddings(database)).toBe(2);

      await replace(repository, [
        { ordinal: 0, content: "ALPHA", startOffset: 0, endOffset: 5 },
        initialChunks[1],
      ]);
      const changedRows = readChunkRows(database);
      expect(changedRows.map((row) => row.chunk_rowid)).toEqual(
        initialRows.map((row) => row.chunk_rowid),
      );
      expect(changedRows[0]?.content_hash).not.toBe(initialRows[0]?.content_hash);
      expect(readEmbeddingValidity(database)).toEqual([
        { ordinal: 0, valid: 0 },
        { ordinal: 1, valid: 1 },
      ]);

      await replace(repository, [{ ordinal: 0, content: "beta", startOffset: 6, endOffset: 10 }]);
      expect(readChunkRows(database)).toEqual([
        expect.objectContaining({
          chunk_rowid: initialRows[1]?.chunk_rowid,
          ordinal: 0,
          content: "beta",
        }),
      ]);
      expect(countEmbeddings(database)).toBe(1);
    } finally {
      await database.close();
    }
  });
});

async function insertSource(database: ProjectDatabase): Promise<void> {
  await database.write((sqlite) => {
    sqlite
      .prepare(
        `INSERT INTO sources
         (id, project_id, source_type, origin, format, title, tags_json, languages_json,
          relative_path, content_hash, size, created_at, updated_at)
         VALUES ('source-1', 'project-1', 'material', 'paste', 'text', 'Source', '[]', '["en"]',
                 'materials/source-1.txt', ?, 100,
                 '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run(SOURCE_HASH);
  });
}

async function replace(
  repository: KnowledgeChunkRepository,
  chunks: readonly {
    ordinal: number;
    content: string;
    startOffset: number;
    endOffset: number;
  }[],
): Promise<void> {
  await repository.replaceForSource({
    sourceId: "source-1",
    expectedContentHash: SOURCE_HASH,
    parserVersion: "parser-v1",
    chunkerVersion: "chunker-v1",
    chunkingConfigJson: "{}",
    chunks,
  });
}

function readChunkRows(database: ProjectDatabase): Array<{
  chunk_rowid: number;
  ordinal: number;
  content: string;
  content_hash: string;
}> {
  return database.read(
    (sqlite) =>
      sqlite
        .prepare(
          `SELECT chunk_rowid, ordinal, content, content_hash
           FROM knowledge_chunks ORDER BY ordinal`,
        )
        .all() as Array<{
        chunk_rowid: number;
        ordinal: number;
        content: string;
        content_hash: string;
      }>,
  );
}

function countEmbeddings(database: ProjectDatabase): number {
  return database.read(
    (sqlite) =>
      (
        sqlite.prepare("SELECT COUNT(*) AS count FROM chunk_embeddings").get() as {
          count: number;
        }
      ).count,
  );
}

function readEmbeddingValidity(database: ProjectDatabase): Array<{
  ordinal: number;
  valid: number;
}> {
  return database.read(
    (sqlite) =>
      sqlite
        .prepare(
          `SELECT kc.ordinal, ce.content_hash = kc.content_hash AS valid
           FROM knowledge_chunks kc
           JOIN chunk_embeddings ce ON ce.chunk_rowid = kc.chunk_rowid
           ORDER BY kc.ordinal`,
        )
        .all() as Array<{ ordinal: number; valid: number }>,
  );
}
