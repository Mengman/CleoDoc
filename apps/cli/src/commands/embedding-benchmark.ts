import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { cpus, tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import {
  ChunkEmbeddingRepository,
  KnowledgeChunkRepository,
  ProjectDatabase,
  SqliteVectorIndex,
} from "../../../../packages/database/src/index.js";
import { AppError } from "../../../../packages/contracts/src/index.js";
import type {
  EmbeddingResult,
  ResolvedEmbeddingModelDefinition,
} from "../../../../packages/rag/src/index.js";
import {
  fuseAndSelectHybridResults,
  NodeLlamaCppEmbeddingRuntime,
} from "../../../../packages/rag/src/index.js";
import {
  corpusFor,
  type BenchmarkDocument,
  type BenchmarkQuery,
} from "./embedding-benchmark-corpus.js";

export interface EmbeddingBenchmarkOptions {
  readonly definition: ResolvedEmbeddingModelDefinition;
  readonly databaseBusyTimeoutMs: number;
  readonly gpuAcceleration: boolean;
  readonly copiesPerDocument: number;
  readonly queryRuns: number;
  readonly output: Pick<NodeJS.WritableStream, "write">;
}

export async function runEmbeddingBenchmark(options: EmbeddingBenchmarkOptions): Promise<void> {
  const corpus = corpusFor(options.definition.language);
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "cleodoc-embedding-benchmark-"));
  let runtime: NodeLlamaCppEmbeddingRuntime | undefined;
  let database: ProjectDatabase | undefined;
  try {
    const loadStartedAt = performance.now();
    runtime = await NodeLlamaCppEmbeddingRuntime.open(options.definition, {
      gpuAcceleration: options.gpuAcceleration,
    });
    const loadDurationMs = performance.now() - loadStartedAt;
    if (options.gpuAcceleration && runtime.info.gpuLayers === 0) {
      throw new AppError(
        "EMBEDDING_MODEL_LOAD_FAILED",
        `GPU auto 没有卸载任何模型层，实际后端为 ${String(runtime.info.gpuBackend)}。`,
      );
    }

    const firstInferenceStartedAt = performance.now();
    await runtime.embedDocument(corpus.documents[0]!.content);
    const firstInferenceDurationMs = performance.now() - firstInferenceStartedAt;
    for (const document of corpus.documents) await runtime.embedDocument(document.content);
    const documentResults = new Map<string, EmbeddingResult>();
    const documentDurations: number[] = [];
    let documentTokens = 0;
    for (const document of corpus.documents) {
      const startedAt = performance.now();
      const result = await runtime.embedDocument(document.content);
      documentDurations.push(performance.now() - startedAt);
      documentTokens += result.tokenCount;
      documentResults.set(document.key, result);
    }

    const queryResults: Array<{ query: BenchmarkQuery; result: EmbeddingResult }> = [];
    const queryEmbeddingDurations: number[] = [];
    for (const query of corpus.queries) await runtime.embedQuery(query.text);
    for (const query of corpus.queries) {
      const startedAt = performance.now();
      const result = await runtime.embedQuery(query.text);
      queryEmbeddingDurations.push(performance.now() - startedAt);
      queryResults.push({ query, result });
    }

    database = await ProjectDatabase.open(temporaryRoot, {
      busyTimeoutMs: options.databaseBusyTimeoutMs,
    });
    const projectId = "embedding-benchmark";
    await seedBenchmarkIndex(
      database,
      projectId,
      options.definition,
      corpus.documents,
      documentResults,
      options.copiesPerDocument,
    );

    const vectorIndex = SqliteVectorIndex.open(database);
    const chunks = new KnowledgeChunkRepository(database);
    const searchDurations: number[] = [];
    const hybridSearchDurations: number[] = [];
    let vectorRecalledAt1 = 0;
    let vectorRecalledAt5 = 0;
    let hybridRecalledAt1 = 0;
    let hybridRecalledAt5 = 0;
    let traceable = true;
    for (const { query, result } of queryResults) {
      let firstResults: Awaited<ReturnType<SqliteVectorIndex["search"]>> | undefined;
      for (let run = 0; run < options.queryRuns; run += 1) {
        const startedAt = performance.now();
        const results = await vectorIndex.search(
          result.vector,
          {
            projectId,
            sourceType: "material",
            embeddingModelName: options.definition.modelName,
            embeddingModelRevision: options.definition.revision,
          },
          5,
        );
        searchDurations.push(performance.now() - startedAt);
        firstResults ??= results;
      }
      if (firstResults === undefined) {
        throw new Error("Embedding benchmark requires at least one query run");
      }
      if (firstResults[0]?.chunk.sourceId === query.expectedDocumentKey) vectorRecalledAt1 += 1;
      if (firstResults.some((hit) => hit.chunk.sourceId === query.expectedDocumentKey)) {
        vectorRecalledAt5 += 1;
      }
      traceable &&= firstResults.every(
        (hit) =>
          hit.chunk.sourceId !== "" &&
          hit.chunk.chunkId !== "" &&
          hit.chunk.startOffset >= 0 &&
          hit.chunk.endOffset > hit.chunk.startOffset,
      );

      let firstHybrid: ReturnType<typeof fuseAndSelectHybridResults> | undefined;
      for (let run = 0; run < options.queryRuns; run += 1) {
        const startedAt = performance.now();
        const filter = { projectId, sourceType: "material" as const };
        const exact = firstHitPerSource(
          chunks.searchExact(filter, query.text, 100),
          (hit) => hit.sourceId,
        );
        const fts = firstHitPerSource(
          chunks.searchFts(filter, query.text, 100),
          (hit) => hit.sourceId,
        );
        const vector = firstHitPerSource(
          await vectorIndex.search(
            result.vector,
            {
              ...filter,
              embeddingModelName: options.definition.modelName,
              embeddingModelRevision: options.definition.revision,
            },
            100,
          ),
          (hit) => hit.chunk.sourceId,
        );
        const hybrid = fuseAndSelectHybridResults(
          { exact, fts, vector },
          {
            rrfK: 60,
            resultLimit: 5,
            contextMaxCharacters: 12_000,
            maxSourceRatio: 0.6,
          },
        );
        hybridSearchDurations.push(performance.now() - startedAt);
        firstHybrid ??= hybrid;
      }
      if (firstHybrid === undefined) throw new Error("Missing hybrid benchmark results");
      if (firstHybrid.results[0]?.chunk.sourceId === query.expectedDocumentKey) {
        hybridRecalledAt1 += 1;
      }
      if (firstHybrid.results.some((hit) => hit.chunk.sourceId === query.expectedDocumentKey)) {
        hybridRecalledAt5 += 1;
      }
      traceable &&= firstHybrid.results.every(
        (hit) =>
          hit.chunk.sourceId !== "" &&
          hit.chunk.chunkId !== "" &&
          hit.chunk.endOffset > hit.chunk.startOffset,
      );
    }

    const documentTotalMs = sum(documentDurations);
    const candidateChunks = corpus.documents.length * options.copiesPerDocument;
    writeReport(options, {
      loadDurationMs,
      firstInferenceDurationMs,
      documentDurations,
      documentTokens,
      documentTotalMs,
      queryEmbeddingDurations,
      searchDurations,
      hybridSearchDurations,
      candidateChunks,
      vectorRecallAt1: vectorRecalledAt1 / corpus.queries.length,
      vectorRecallAt5: vectorRecalledAt5 / corpus.queries.length,
      hybridRecallAt1: hybridRecalledAt1 / corpus.queries.length,
      hybridRecallAt5: hybridRecalledAt5 / corpus.queries.length,
      traceable,
      dimensions: runtime.info.embeddingDimensions,
      gpuBackend: runtime.info.gpuBackend,
      gpuLayers: runtime.info.gpuLayers,
      sqliteVecVersion: vectorIndex.extensionVersion,
    });
  } finally {
    await database?.close().catch(() => undefined);
    await runtime?.dispose().catch(() => undefined);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

interface BenchmarkReport {
  readonly loadDurationMs: number;
  readonly firstInferenceDurationMs: number;
  readonly documentDurations: readonly number[];
  readonly documentTokens: number;
  readonly documentTotalMs: number;
  readonly queryEmbeddingDurations: readonly number[];
  readonly searchDurations: readonly number[];
  readonly hybridSearchDurations: readonly number[];
  readonly candidateChunks: number;
  readonly vectorRecallAt1: number;
  readonly vectorRecallAt5: number;
  readonly hybridRecallAt1: number;
  readonly hybridRecallAt5: number;
  readonly traceable: boolean;
  readonly dimensions: number;
  readonly gpuBackend: string | false;
  readonly gpuLayers: number;
  readonly sqliteVecVersion: string;
}

function writeReport(options: EmbeddingBenchmarkOptions, report: BenchmarkReport): void {
  const documentStats = summarizeDurations(report.documentDurations);
  const queryStats = summarizeDurations(report.queryEmbeddingDurations);
  const searchStats = summarizeDurations(report.searchDurations);
  const hybridSearchStats = summarizeDurations(report.hybridSearchDurations);
  const seconds = report.documentTotalMs / 1_000;
  const cpu = cpus()[0]?.model ?? "unknown";
  const write = (line: string): void => void options.output.write(`${line}\n`);

  write(`CleoDoc Embedding ${options.gpuAcceleration ? "GPU" : "CPU"} Baseline`);
  write(`平台：${process.platform} ${process.arch} / Node ${process.version}`);
  write(`CPU：${cpu}`);
  write(`模型：${options.definition.modelId}`);
  write(`模型身份：${options.definition.modelName} @ ${options.definition.revision}`);
  write(
    `推理设备：${options.gpuAcceleration ? "GPU auto" : "CPU"}；实际后端 ${String(report.gpuBackend)}；GPU Layers ${report.gpuLayers}`,
  );
  write(`向量维度：${report.dimensions}`);
  write(`模型加载：${formatMs(report.loadDurationMs)}`);
  write(`首次 Chunk 推理：${formatMs(report.firstInferenceDurationMs)}`);
  write(
    `单 Chunk：avg ${formatMs(documentStats.average)} / p50 ${formatMs(documentStats.p50)} / p95 ${formatMs(documentStats.p95)}`,
  );
  write(
    `顺序吞吐：${(report.documentDurations.length / seconds).toFixed(2)} chunks/s / ${(report.documentTokens / seconds).toFixed(1)} tokens/s`,
  );
  write(
    `Query Embedding：avg ${formatMs(queryStats.average)} / p50 ${formatMs(queryStats.p50)} / p95 ${formatMs(queryStats.p95)}`,
  );
  write(`SQLite：sqlite-vec ${report.sqliteVecVersion}，候选 ${report.candidateChunks} chunks`);
  write(
    `SQLite 精确查询：avg ${formatMs(searchStats.average)} / p50 ${formatMs(searchStats.p50)} / p95 ${formatMs(searchStats.p95)}`,
  );
  write(
    `混合检索：avg ${formatMs(hybridSearchStats.average)} / p50 ${formatMs(hybridSearchStats.p50)} / p95 ${formatMs(hybridSearchStats.p95)}`,
  );
  write(`固定语料 Vector Top-1 Recall：${(report.vectorRecallAt1 * 100).toFixed(1)}%`);
  write(`固定语料 Vector Top-5 Recall：${(report.vectorRecallAt5 * 100).toFixed(1)}%`);
  write(`固定语料 Hybrid Top-1 Recall：${(report.hybridRecallAt1 * 100).toFixed(1)}%`);
  write(`固定语料 Hybrid Top-5 Recall：${(report.hybridRecallAt5 * 100).toFixed(1)}%`);
  write(`结果可追溯性：${report.traceable ? "通过" : "失败"}`);
}

async function seedBenchmarkIndex(
  database: ProjectDatabase,
  projectId: string,
  definition: ResolvedEmbeddingModelDefinition,
  documents: readonly BenchmarkDocument[],
  results: ReadonlyMap<string, EmbeddingResult>,
  copiesPerDocument: number,
): Promise<void> {
  const chunks = new KnowledgeChunkRepository(database);
  const embeddings = new ChunkEmbeddingRepository(database);
  const now = new Date().toISOString();
  for (const document of documents) {
    const contentHash = sha256(document.content);
    const sourceSize = Buffer.byteLength(document.content, "utf8");
    await database.write((sqlite) => {
      sqlite
        .prepare(
          `INSERT INTO sources
           (id, project_id, source_type, origin, format, title, tags_json, languages_json,
            relative_path, content_hash, size, created_at, updated_at)
           VALUES (?, ?, 'material', 'paste', 'text', ?, '[]', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          document.key,
          projectId,
          document.title,
          JSON.stringify([definition.language]),
          `materials/${document.key}.txt`,
          contentHash,
          sourceSize,
          now,
          now,
        );
    });
    await chunks.replaceForSource({
      sourceId: document.key,
      expectedContentHash: contentHash,
      parserVersion: "embedding-benchmark",
      chunkerVersion: "embedding-benchmark",
      chunkingConfigJson: JSON.stringify({
        modelName: definition.modelName,
        revision: definition.revision,
      }),
      chunks: Array.from({ length: copiesPerDocument }, (_, ordinal) => ({
        ordinal,
        content: document.content,
        startOffset: 0,
        endOffset: sourceSize,
      })),
    });
  }

  const identity = { modelName: definition.modelName, revision: definition.revision };
  const pending = embeddings.listPending(projectId, definition.language, identity);
  await embeddings.writeBatch(
    projectId,
    definition.language,
    identity,
    pending.chunks.map((snapshot) => ({
      snapshot,
      vector: requireResult(results, snapshot.sourceId).vector,
    })),
  );
}

function requireResult(
  results: ReadonlyMap<string, EmbeddingResult>,
  sourceId: string,
): EmbeddingResult {
  const result = results.get(sourceId);
  if (result === undefined) throw new Error(`Missing benchmark vector for ${sourceId}`);
  return result;
}

function firstHitPerSource<T>(hits: readonly T[], getSourceId: (hit: T) => string): T[] {
  const seen = new Set<string>();
  return hits.filter((hit) => {
    const sourceId = getSourceId(hit);
    if (seen.has(sourceId)) return false;
    seen.add(sourceId);
    return true;
  });
}

function summarizeDurations(values: readonly number[]): {
  average: number;
  p50: number;
  p95: number;
} {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    average: sum(sorted) / sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
  };
}

function percentile(sorted: readonly number[], ratio: number): number {
  const index = Math.max(0, Math.ceil(sorted.length * ratio) - 1);
  return sorted[index]!;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function formatMs(value: number): string {
  return `${value.toFixed(2)} ms`;
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}
