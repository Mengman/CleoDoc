import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AppError } from "../../../../packages/contracts/src/index.js";
import { parseArguments } from "../arguments.js";
import { executeIndexCommand } from "./index-command.js";
import type { RagCommandDependencies } from "./rag-command-types.js";
import { executeSearchCommand } from "./search-command.js";

const temporaryDirectories: string[] = [];
type RagMaterialService = Awaited<ReturnType<RagCommandDependencies["openMaterials"]>>;

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("RAG CLI commands", () => {
  it("prints embedding progress, model totals, and safe debug metadata", async () => {
    const root = await createTemporaryDirectory();
    const output = createOutput();
    const service = createService({
      async embedIndex(options) {
        options?.onProgress?.({
          language: "zh",
          modelId: "model-zh",
          completedChunks: 1,
          totalChunks: 1,
          chunkId: "public-chunk-id",
        });
        return embeddingResult();
      },
    });

    await executeIndexCommand(parseArguments(["index", "embed", "--debug"]), {
      output,
      defaultDebug: false,
      resolveProjectRoot: async () => root,
      openMaterials: async () => service,
    });

    expect(output.content).toContain("Embedding zh model-zh：1/1");
    expect(output.content).toContain("处理 1\t跳过 0\t写入 1");
    expect(output.content).toContain("失败 0");
    const logDirectory = path.join(root, ".cleo", "logs");
    const [logName] = await readdir(logDirectory);
    const log = await readFile(path.join(logDirectory, logName!), "utf8");
    expect(log).toContain('"modelId":"model-zh"');
    expect(log).toContain('"dimensions":384');
    expect(log).not.toContain("public-chunk-id");
  });

  it("prints embedding coverage in index status", async () => {
    const output = createOutput();
    const service = createService({
      async getIndexStatus() {
        return [
          {
            sourceId: "source-1",
            title: "资料",
            status: "ready",
            chunkCount: 3,
            parserVersion: "parser-v1",
            chunkerVersion: "chunker-v1",
            indexedAt: "2026-08-09T00:00:00.000Z",
            errorCode: null,
            language: "zh",
            embeddingModelId: "model-zh",
            embeddedChunkCount: 2,
            pendingEmbeddingCount: 1,
          },
        ];
      },
    });
    await executeIndexCommand(parseArguments(["index", "status"]), dependencies(output, service));
    expect(output.content).toContain("embedding: 2/3");
    expect(output.content).toContain("pending: 1");
    expect(output.content).toContain("model: model-zh");
  });

  it("keeps FTS usable when semantic search is unavailable and never logs text", async () => {
    const root = await createTemporaryDirectory();
    const output = createOutput();
    let semanticUnavailable = true;
    const service = createService({
      async search(query) {
        return [searchHit(`FTS:${query}`)];
      },
      async searchSemantic() {
        if (semanticUnavailable) {
          throw new AppError("VECTOR_INDEX_UNAVAILABLE", "vector unavailable");
        }
        return {
          language: "en",
          modelId: "model-en",
          tokenCount: 4,
          dimensions: 384,
          embeddingDurationMs: 12,
          searchDurationMs: 3,
          results: [{ chunk: searchHit("private material text"), distance: 0.25 }],
        };
      },
    });
    const commandDependencies = {
      ...dependencies(output, service),
      resolveProjectRoot: async () => root,
    };

    await expect(
      executeSearchCommand(
        parseArguments(["search", "private query text", "--semantic", "--debug"]),
        commandDependencies,
      ),
    ).rejects.toMatchObject({ code: "VECTOR_INDEX_UNAVAILABLE" });
    semanticUnavailable = false;
    await executeSearchCommand(
      parseArguments(["search", "private query text", "--semantic", "--debug"]),
      commandDependencies,
    );
    await executeSearchCommand(parseArguments(["search", "exact keyword"]), commandDependencies);

    expect(output.content).toContain("distance: 0.250000");
    expect(output.content).toContain("FTS:exact keyword");
    const logs = await readdir(path.join(root, ".cleo", "logs"));
    for (const logName of logs) {
      const log = await readFile(path.join(root, ".cleo", "logs", logName), "utf8");
      expect(log).not.toContain("private query text");
      expect(log).not.toContain("private material text");
    }
  });

  it("prints explainable hybrid ranks without logging content", async () => {
    const root = await createTemporaryDirectory();
    const output = createOutput();
    const privateResult = hybridSearchResult();
    const service = createService({
      async searchHybrid() {
        return privateResult;
      },
    });

    await executeSearchCommand(
      parseArguments(["search", "private hybrid query", "--hybrid", "--explain", "--debug"]),
      {
        ...dependencies(output, service),
        resolveProjectRoot: async () => root,
      },
    );

    expect(output.content).toContain("exact#1, fts#1, vector#1");
    expect(output.content).toContain("上下文字符数：");
    const [logName] = await readdir(path.join(root, ".cleo", "logs"));
    const log = await readFile(path.join(root, ".cleo", "logs", logName!), "utf8");
    expect(log).toContain('"operation":"hybrid-search"');
    expect(log).not.toContain("private hybrid query");
    expect(log).not.toContain("hybrid evidence");
  });
});

function createService(overrides: Partial<RagMaterialService> = {}): RagMaterialService {
  return {
    async close() {},
    async embedIndex() {
      return embeddingResult();
    },
    async getIndexStatus() {
      return [];
    },
    async rebuildFts() {},
    async rebuildIndex() {
      return { indexedCount: 0, failed: [] };
    },
    async search() {
      return [];
    },
    async searchHybrid() {
      return hybridSearchResult();
    },
    async searchSemantic() {
      return {
        language: "zh",
        modelId: "model-zh",
        tokenCount: 1,
        dimensions: 384,
        embeddingDurationMs: 1,
        searchDurationMs: 1,
        results: [],
      };
    },
    ...overrides,
  };
}

function dependencies(
  output: ReturnType<typeof createOutput>,
  service: RagMaterialService,
): RagCommandDependencies {
  return {
    output,
    defaultDebug: false,
    resolveProjectRoot: async () => "project-root",
    openMaterials: async () => service,
  };
}

function embeddingResult() {
  return {
    totalChunks: 1,
    processedChunks: 1,
    skippedChunks: 0,
    writtenChunks: 1,
    discardedChunks: 0,
    failedChunks: 0,
    models: [
      {
        language: "zh" as const,
        modelId: "model-zh",
        totalChunks: 1,
        processedChunks: 1,
        skippedChunks: 0,
        writtenChunks: 1,
        discardedChunks: 0,
        failedChunks: 0,
        tokenCount: 24,
        dimensions: 384,
        durationMs: 10,
        errorCode: null,
        errorMessage: null,
      },
      {
        language: "en" as const,
        modelId: "model-en",
        totalChunks: 0,
        processedChunks: 0,
        skippedChunks: 0,
        writtenChunks: 0,
        discardedChunks: 0,
        failedChunks: 0,
        tokenCount: 0,
        dimensions: null,
        durationMs: 1,
        errorCode: null,
        errorMessage: null,
      },
    ],
  };
}

function searchHit(content: string) {
  return {
    sourceTitle: "Source",
    sourceRevision: "source-revision",
    sourceUpdatedAt: "2026-08-09T00:00:00.000Z",
    sourceId: "source-1",
    chunkId: "chunk-1",
    content,
    startOffset: 0,
    endOffset: content.length,
  };
}

function hybridSearchResult() {
  const hit = {
    chunk: searchHit("hybrid evidence"),
    score: 0.05,
    ranks: [
      { method: "exact" as const, rank: 1 },
      { method: "fts" as const, rank: 1 },
      { method: "vector" as const, rank: 1 },
    ],
    vectorDistance: 0.1,
  };
  return {
    language: "zh" as const,
    embeddingModelId: "model-zh",
    queryTokenCount: 3,
    exactCandidateCount: 1,
    ftsCandidateCount: 1,
    vectorCandidateCount: 1,
    embeddingDurationMs: 1,
    retrievalDurationMs: 2,
    vectorErrorCode: null,
    retrievalContext: {
      items: [hit],
      contentCharacterCount: hit.chunk.content.length,
    },
  };
}

function createOutput(): { readonly content: string; write(content: string): void } {
  let content = "";
  return {
    get content() {
      return content;
    },
    write(value: string) {
      content += value;
    },
  };
}

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "cleodoc-rag-command-test-"));
  temporaryDirectories.push(directory);
  return directory;
}
