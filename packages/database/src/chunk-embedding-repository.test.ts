import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { TEST_DATABASE_OPTIONS } from "../../../test/runtime-options.js";
import { ChunkEmbeddingRepository } from "./chunk-embedding-repository.js";
import { KnowledgeChunkRepository } from "./knowledge-chunk-repository.js";
import { ProjectDatabase } from "./project-database.js";

const temporaryDirectories: string[] = [];
const SOURCE_HASH = "0".repeat(64);
const MODEL = { modelId: "model-zh-v1", modelName: "test/zh", revision: "v1" } as const;

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("ChunkEmbeddingRepository", () => {
  it("writes only missing embeddings and stores Float32 values as little-endian bytes", async () => {
    const { database, chunks } = await createIndexedSource();
    const repository = new ChunkEmbeddingRepository(database);
    try {
      const pending = repository.listPending("project-1", "zh", MODEL.modelId);
      expect(pending).toMatchObject({ totalChunks: 2 });
      expect(pending.chunks.map((chunk) => chunk.chunkId)).toEqual(
        chunks.map((chunk) => chunk.chunkId),
      );

      await expect(
        repository.writeBatch("project-1", "zh", MODEL, [
          { snapshot: pending.chunks[0]!, vector: Float32Array.from([1, -2.5]) },
          { snapshot: pending.chunks[1]!, vector: Float32Array.from([3, 4]) },
        ]),
      ).resolves.toEqual({ writtenCount: 2, discardedCount: 0 });

      expect(repository.listPending("project-1", "zh", MODEL.modelId)).toEqual({
        totalChunks: 2,
        chunks: [],
      });
      const bytes = database.read(
        (sqlite) =>
          (
            sqlite
              .prepare(
                `SELECT embedding FROM chunk_embeddings
                 WHERE embedding_model_id = ? ORDER BY chunk_rowid LIMIT 1`,
              )
              .get(MODEL.modelId) as { embedding: Uint8Array }
          ).embedding,
      );
      const buffer = Buffer.from(bytes);
      expect(buffer.readFloatLE(0)).toBe(1);
      expect(buffer.readFloatLE(4)).toBe(-2.5);
    } finally {
      await database.close();
    }
  });

  it("discards a result when the chunk changes after its snapshot was selected", async () => {
    const { database } = await createIndexedSource();
    const embeddings = new ChunkEmbeddingRepository(database);
    const chunks = new KnowledgeChunkRepository(database);
    try {
      const snapshot = embeddings.listPending("project-1", "zh", MODEL.modelId).chunks[0]!;
      await chunks.replaceForSource({
        sourceId: "source-1",
        expectedContentHash: SOURCE_HASH,
        parserVersion: "parser-v1",
        chunkerVersion: "chunker-v1",
        chunkingConfigJson: chunkingConfig(),
        chunks: [
          { ordinal: 0, content: "changed", startOffset: 0, endOffset: 7 },
          { ordinal: 1, content: "beta", startOffset: 8, endOffset: 12 },
        ],
      });

      await expect(
        embeddings.writeBatch("project-1", "zh", MODEL, [
          { snapshot, vector: Float32Array.from([1, 2]) },
        ]),
      ).resolves.toEqual({ writtenCount: 0, discardedCount: 1 });
      expect(countEmbeddings(database)).toBe(0);
      expect(embeddings.listPending("project-1", "zh", MODEL.modelId).chunks).toHaveLength(2);
    } finally {
      await database.close();
    }
  });

  it("does not select stale sources or a different primary language", async () => {
    const { database } = await createIndexedSource();
    const repository = new ChunkEmbeddingRepository(database);
    try {
      expect(repository.listPending("project-1", "en", "model-en")).toEqual({
        totalChunks: 0,
        chunks: [],
      });
      await database.write((sqlite) => {
        sqlite.prepare("UPDATE sources SET index_status = 'stale' WHERE id = 'source-1'").run();
      });
      expect(repository.listPending("project-1", "zh", MODEL.modelId)).toEqual({
        totalChunks: 0,
        chunks: [],
      });
    } finally {
      await database.close();
    }
  });
});

async function createIndexedSource(): Promise<{
  database: ProjectDatabase;
  chunks: Array<{ chunkId: string }>;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "cleodoc-embedding-repository-test-"));
  temporaryDirectories.push(root);
  const database = await ProjectDatabase.open(root, TEST_DATABASE_OPTIONS);
  await database.write((sqlite) => {
    sqlite
      .prepare(
        `INSERT INTO sources
         (id, project_id, source_type, origin, format, title, tags_json, languages_json,
          relative_path, content_hash, size, created_at, updated_at)
         VALUES ('source-1', 'project-1', 'material', 'paste', 'text', 'Source', '[]', '["zh"]',
                 'materials/source-1.txt', ?, 100,
                 '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run(SOURCE_HASH);
  });
  const chunks = await new KnowledgeChunkRepository(database).replaceForSource({
    sourceId: "source-1",
    expectedContentHash: SOURCE_HASH,
    parserVersion: "parser-v1",
    chunkerVersion: "chunker-v1",
    chunkingConfigJson: chunkingConfig(),
    chunks: [
      { ordinal: 0, content: "alpha", startOffset: 0, endOffset: 5 },
      { ordinal: 1, content: "beta", startOffset: 6, endOffset: 10 },
    ],
  });
  return { database, chunks };
}

function chunkingConfig(): string {
  return JSON.stringify({
    tokenizerModelId: MODEL.modelId,
    tokenizerRevision: MODEL.revision,
    maxInputTokens: 512,
    splitSearchWindowRatio: 0.75,
  });
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
