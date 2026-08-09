import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import * as sqliteVec from "sqlite-vec";
import { afterEach, describe, expect, it } from "vitest";

import { TEST_DATABASE_OPTIONS } from "../../../test/runtime-options.js";
import { encodeFloat32LittleEndian } from "./float32-vector.js";
import { KnowledgeChunkRepository } from "./knowledge-chunk-repository.js";
import { ProjectDatabase } from "./project-database.js";
import { SqliteVectorIndex } from "./sqlite-vector-index.js";

const temporaryDirectories: string[] = [];
const MODEL_ID = "model-zh-v1";
const OTHER_MODEL_ID = "model-zh-v2";

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("SqliteVectorIndex", () => {
  it("loads the pinned extension, performs exact cosine search, then disables loading", async () => {
    const database = await createDatabase();
    try {
      await addVector(database, "target", "project-1", MODEL_ID, [1, 0]);
      await addVector(database, "near", "project-1", MODEL_ID, [0.8, 0.2]);
      const index = SqliteVectorIndex.open(database);

      expect(index.extensionVersion).toBe("v0.1.9");
      expect(
        database.read((sqlite) => {
          try {
            sqlite.loadExtension(sqliteVec.getLoadablePath());
            return false;
          } catch {
            return true;
          }
        }),
      ).toBe(true);

      const results = await index.search(
        Float32Array.from([1, 0]),
        { projectId: "project-1", embeddingModelId: MODEL_ID },
        10,
      );
      expect(results.map((result) => result.sourceId)).toEqual(["target", "near"]);
      expect(results[0]?.distance).toBeCloseTo(0);
      expect(results[1]?.distance).toBeGreaterThan(0);
    } finally {
      await database.close();
    }
  });

  it("excludes other projects, stale sources, stale vectors, and other models", async () => {
    const database = await createDatabase();
    try {
      await addVector(database, "valid", "project-1", MODEL_ID, [0.9, 0.1]);
      await addVector(database, "other-project", "project-2", MODEL_ID, [1, 0]);
      await addVector(database, "stale-source", "project-1", MODEL_ID, [1, 0]);
      await addVector(database, "stale-vector", "project-1", MODEL_ID, [1, 0]);
      await addVector(database, "other-model", "project-1", OTHER_MODEL_ID, [1, 0]);
      await database.write((sqlite) => {
        sqlite.prepare("UPDATE sources SET index_status = 'stale' WHERE id = 'stale-source'").run();
        sqlite
          .prepare(
            `UPDATE chunk_embeddings SET content_hash = ?
             WHERE chunk_rowid = (SELECT chunk_rowid FROM knowledge_chunks WHERE source_id = ?)`,
          )
          .run("f".repeat(64), "stale-vector");
      });

      const index = SqliteVectorIndex.open(database);
      const results = await index.search(
        Float32Array.from([1, 0]),
        { projectId: "project-1", embeddingModelId: MODEL_ID },
        10,
      );
      expect(results.map((result) => result.sourceId)).toEqual(["valid"]);
    } finally {
      await database.close();
    }
  });

  it("rejects a query vector with different dimensions", async () => {
    const database = await createDatabase();
    try {
      await addVector(database, "source", "project-1", MODEL_ID, [1, 0]);
      const index = SqliteVectorIndex.open(database);
      await expect(
        index.search(
          Float32Array.from([1, 0, 0]),
          { projectId: "project-1", embeddingModelId: MODEL_ID },
          10,
        ),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    } finally {
      await database.close();
    }
  });
});

async function createDatabase(): Promise<ProjectDatabase> {
  const root = await mkdtemp(path.join(tmpdir(), "cleodoc-vector-index-test-"));
  temporaryDirectories.push(root);
  const database = await ProjectDatabase.open(root, TEST_DATABASE_OPTIONS);
  await database.write((sqlite) => {
    const insert = sqlite.prepare(
      `INSERT INTO embedding_models
       (embedding_model_id, model_name, revision, created_at) VALUES (?, ?, 'v1', ?)`,
    );
    insert.run(MODEL_ID, "test/zh", "2026-01-01T00:00:00.000Z");
    insert.run(OTHER_MODEL_ID, "test/zh-other", "2026-01-01T00:00:00.000Z");
  });
  return database;
}

async function addVector(
  database: ProjectDatabase,
  sourceId: string,
  projectId: string,
  modelId: string,
  vector: readonly number[],
): Promise<void> {
  const sourceHash = sourceId.padEnd(64, "0").slice(0, 64);
  await database.write((sqlite) => {
    sqlite
      .prepare(
        `INSERT INTO sources
         (id, project_id, source_type, origin, format, title, tags_json, languages_json,
          relative_path, content_hash, size, created_at, updated_at)
         VALUES (?, ?, 'material', 'paste', 'text', ?, '[]', '["zh"]', ?, ?, 100, ?, ?)`,
      )
      .run(
        sourceId,
        projectId,
        sourceId,
        `materials/${sourceId}.txt`,
        sourceHash,
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      );
  });
  const [chunk] = await new KnowledgeChunkRepository(database).replaceForSource({
    sourceId,
    expectedContentHash: sourceHash,
    parserVersion: "parser-v1",
    chunkerVersion: "chunker-v1",
    chunkingConfigJson: "{}",
    chunks: [{ ordinal: 0, content: sourceId, startOffset: 0, endOffset: sourceId.length }],
  });
  await database.write((sqlite) => {
    const row = sqlite
      .prepare("SELECT chunk_rowid, content_hash FROM knowledge_chunks WHERE chunk_id = ?")
      .get(chunk!.chunkId) as { chunk_rowid: number; content_hash: string };
    sqlite
      .prepare(
        `INSERT INTO chunk_embeddings
         (embedding_model_id, chunk_rowid, content_hash, embedding, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        modelId,
        row.chunk_rowid,
        row.content_hash,
        encodeFloat32LittleEndian(Float32Array.from(vector)),
        "2026-01-01T00:00:00.000Z",
      );
  });
}
