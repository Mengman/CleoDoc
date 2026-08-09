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
  EmbeddingLanguage,
  EmbeddingResult,
  ResolvedEmbeddingModelDefinition,
} from "../../../../packages/rag/src/index.js";
import { NodeLlamaCppEmbeddingRuntime } from "../../../../packages/rag/src/index.js";

interface BenchmarkDocument {
  readonly key: string;
  readonly title: string;
  readonly content: string;
}

interface BenchmarkQuery {
  readonly text: string;
  readonly expectedDocumentKey: string;
}

interface BenchmarkCorpus {
  readonly documents: readonly BenchmarkDocument[];
  readonly queries: readonly BenchmarkQuery[];
}

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
    const searchDurations: number[] = [];
    let recalledAt1 = 0;
    let recalledAt5 = 0;
    let traceable = true;
    for (const { query, result } of queryResults) {
      let firstResults: Awaited<ReturnType<SqliteVectorIndex["search"]>> | undefined;
      for (let run = 0; run < options.queryRuns; run += 1) {
        const startedAt = performance.now();
        const results = await vectorIndex.search(
          result.vector,
          {
            projectId,
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
      if (firstResults[0]?.sourceId === query.expectedDocumentKey) recalledAt1 += 1;
      if (firstResults.some((hit) => hit.sourceId === query.expectedDocumentKey)) recalledAt5 += 1;
      traceable &&= firstResults.every(
        (hit) =>
          hit.sourceId !== "" &&
          hit.chunkId !== "" &&
          hit.startOffset >= 0 &&
          hit.endOffset > hit.startOffset,
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
      candidateChunks,
      recallAt1: recalledAt1 / corpus.queries.length,
      recallAt5: recalledAt5 / corpus.queries.length,
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
  readonly candidateChunks: number;
  readonly recallAt1: number;
  readonly recallAt5: number;
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
  write(`固定语料 Top-1 Query Recall：${(report.recallAt1 * 100).toFixed(1)}%`);
  write(`固定语料 Top-5 Query Recall：${(report.recallAt5 * 100).toFixed(1)}%`);
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

function corpusFor(language: EmbeddingLanguage): BenchmarkCorpus {
  return language === "zh" ? CHINESE_CORPUS : ENGLISH_CORPUS;
}

const CHINESE_CORPUS: BenchmarkCorpus = {
  documents: [
    {
      key: "city-gate",
      title: "城门值守记录",
      content: "守城士兵每天深夜封闭城门，核对通行凭证后才允许旅人进出城市。",
    },
    {
      key: "railway-lighting",
      title: "铁路照明记录",
      content: "蒸汽列车抵达小站时，站务员会点亮煤油灯，为夜班列车照明并检查信号。",
    },
    {
      key: "medical-treatment",
      title: "诊疗记录",
      content: "医生确认患者受到细菌感染后使用青霉素治疗，并持续观察体温和伤口变化。",
    },
    {
      key: "village-water",
      title: "村庄供水记录",
      content: "旱季河流干涸以后，村民从山脚的深井提取饮用水，再运送到各户储存。",
    },
    {
      key: "observatory",
      title: "天文台记录",
      content: "天文学家使用射电望远镜接收遥远星系的信号，研究恒星诞生和宇宙演化。",
    },
    {
      key: "merchant-credit",
      title: "商会信用记录",
      content: "商人凭借仓单向银行申请短期贷款，以便在货物售出以前支付运输费用。",
    },
  ],
  queries: [
    { text: "夜间什么时候停止人员从城市入口通行？", expectedDocumentKey: "city-gate" },
    { text: "火车站怎样为深夜到达的车辆提供光线？", expectedDocumentKey: "railway-lighting" },
    { text: "患者感染以后使用了哪一种抗生素？", expectedDocumentKey: "medical-treatment" },
    { text: "河水枯竭时居民从哪里取得饮用水？", expectedDocumentKey: "village-water" },
  ],
};

const ENGLISH_CORPUS: BenchmarkCorpus = {
  documents: [
    {
      key: "city-gate",
      title: "City gate record",
      content:
        "The guards close the city gate late every night and inspect travel permits before allowing anyone to enter or leave.",
    },
    {
      key: "railway-lighting",
      title: "Railway lighting record",
      content:
        "When the steam train reaches the rural station, workers light kerosene lamps for the night service and inspect the signals.",
    },
    {
      key: "medical-treatment",
      title: "Medical record",
      content:
        "After confirming a bacterial infection, the physician treats the patient with penicillin and monitors the fever and wound.",
    },
    {
      key: "village-water",
      title: "Village water record",
      content:
        "When the river dries during the drought, villagers draw drinking water from a deep well near the mountain and carry it home.",
    },
    {
      key: "observatory",
      title: "Observatory record",
      content:
        "Astronomers use a radio telescope to receive signals from distant galaxies and study the formation of stars.",
    },
    {
      key: "merchant-credit",
      title: "Merchant credit record",
      content:
        "The merchant uses warehouse receipts to obtain a short-term bank loan and pay transport costs before the goods are sold.",
    },
  ],
  queries: [
    {
      text: "When is passage through the town entrance stopped?",
      expectedDocumentKey: "city-gate",
    },
    {
      text: "How does the station illuminate trains arriving after dark?",
      expectedDocumentKey: "railway-lighting",
    },
    {
      text: "Which antibiotic is given for the infection?",
      expectedDocumentKey: "medical-treatment",
    },
    {
      text: "Where do residents obtain drinking water after the river dries?",
      expectedDocumentKey: "village-water",
    },
  ],
};
