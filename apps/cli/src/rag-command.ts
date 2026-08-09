import { performance } from "node:perf_hooks";

import { AppError, asAppError } from "../../../packages/contracts/src/index.js";
import type { MaterialService } from "../../../packages/knowledge/src/index.js";
import {
  assertOnlyOptions,
  optionBoolean,
  optionString,
  type ParsedArguments,
} from "./arguments.js";
import { RagDebugFileLogger } from "./rag-debug-log.js";

interface CommandOutput {
  write(content: string): unknown;
}

export interface RagCommandDependencies {
  readonly output: CommandOutput;
  readonly defaultDebug: boolean;
  readonly resolveProjectRoot: (explicitProject: string | undefined) => Promise<string>;
  readonly openMaterials: (projectRoot: string) => Promise<RagMaterialService>;
}

type RagMaterialService = Pick<
  MaterialService,
  | "close"
  | "embedIndex"
  | "getIndexStatus"
  | "rebuildFts"
  | "rebuildIndex"
  | "search"
  | "searchSemantic"
>;

export async function runIndexCommand(
  parsed: ParsedArguments,
  dependencies: RagCommandDependencies,
): Promise<void> {
  const [subcommand] = parsed.positionals;
  if (
    parsed.positionals.length !== 1 ||
    !["status", "rebuild", "embed"].includes(subcommand ?? "")
  ) {
    throw new AppError("VALIDATION_ERROR", "用法：cleo index <status|rebuild|embed>");
  }
  assertOnlyOptions(parsed, subcommand === "embed" ? ["project", "debug"] : ["project"]);
  const root = await dependencies.resolveProjectRoot(optionString(parsed, "project"));
  const materials = await dependencies.openMaterials(root);
  try {
    if (subcommand === "status") {
      await printIndexStatus(materials, dependencies.output);
      return;
    }
    if (subcommand === "rebuild") {
      await rebuildIndex(materials, dependencies.output);
      return;
    }
    await embedIndex(materials, root, resolveDebug(parsed, dependencies), dependencies.output);
  } finally {
    await materials.close();
  }
}

export async function runSearchCommand(
  parsed: ParsedArguments,
  dependencies: RagCommandDependencies,
): Promise<void> {
  assertOnlyOptions(parsed, ["project", "limit", "scope", "semantic", "debug"]);
  const [query] = parsed.positionals;
  if (query === undefined || parsed.positionals.length !== 1) {
    throw new AppError(
      "VALIDATION_ERROR",
      "用法：cleo search <query> [--semantic] [--limit <数量>]",
    );
  }
  const scope = optionString(parsed, "scope") ?? "material";
  if (scope !== "material") {
    throw new AppError("VALIDATION_ERROR", "当前检索只支持 --scope material。");
  }
  const semantic = optionBoolean(parsed, "semantic");
  const explicitDebug = parsed.options.has("debug");
  if (explicitDebug && !semantic) {
    throw new AppError("VALIDATION_ERROR", "--debug 当前只用于 --semantic 检索。");
  }
  const debug = semantic && resolveDebug(parsed, dependencies);
  const limit = positiveIntegerOption(parsed, "limit") ?? 10;
  if (limit > 100) {
    throw new AppError("VALIDATION_ERROR", "--limit 不能超过 100。");
  }
  const root = await dependencies.resolveProjectRoot(optionString(parsed, "project"));
  const materials = await dependencies.openMaterials(root);
  try {
    if (!semantic) {
      printResults(await materials.search(query, limit), dependencies.output);
      return;
    }
    await semanticSearch(materials, root, query, limit, debug, dependencies.output);
  } finally {
    await materials.close();
  }
}

async function printIndexStatus(
  materials: RagMaterialService,
  output: CommandOutput,
): Promise<void> {
  const statuses = await materials.getIndexStatus();
  if (statuses.length === 0) {
    output.write("尚无可索引资料。\n");
    return;
  }
  for (const status of statuses) {
    output.write(
      `${status.sourceId}\t${status.title}\t${status.status}\t${status.chunkCount} chunks\n` +
        `  embedding: ${status.embeddedChunkCount}/${status.chunkCount}` +
        `\tpending: ${status.pendingEmbeddingCount}` +
        `\tlanguage: ${status.language}\tmodel: ${status.embeddingModelId}` +
        `${status.errorCode === null ? "" : `\terror: ${status.errorCode}`}\n`,
    );
  }
}

async function rebuildIndex(materials: RagMaterialService, output: CommandOutput): Promise<void> {
  const result = await materials.rebuildIndex();
  await materials.rebuildFts();
  output.write(
    `索引重建完成：${result.indexedCount} 份资料成功，${result.failed.length} 份失败。\n`,
  );
  for (const failure of result.failed) {
    output.write(
      `失败 [${failure.errorCode}]：${failure.title}（${failure.sourceId}）— ${failure.message}\n`,
    );
  }
}

async function embedIndex(
  materials: RagMaterialService,
  projectRoot: string,
  debug: boolean,
  output: CommandOutput,
): Promise<void> {
  const logger = debug ? await RagDebugFileLogger.create(projectRoot) : null;
  if (logger !== null) output.write(`RAG Debug 日志：${logger.filePath}\n`);
  const controller = new AbortController();
  const removeInterrupt = installEmbeddingInterruptHandler(controller, output);
  const progress = new EmbeddingProgressPrinter(output);
  const startedAt = performance.now();
  let failureLogged = false;
  try {
    const result = await materials.embedIndex({
      signal: controller.signal,
      continueOnError: true,
      onProgress: (event) => progress.print(event),
    });
    for (const model of result.models) {
      output.write(
        `${model.language}\t${model.modelId}\t处理 ${model.processedChunks}` +
          `\t跳过 ${model.skippedChunks}\t写入 ${model.writtenChunks}` +
          `\t丢弃 ${model.discardedChunks}\t失败 ${model.failedChunks}\n`,
      );
      await logger?.write({
        operation: "index-embed",
        status: model.errorCode === null ? "completed" : "failed",
        modelId: model.modelId,
        language: model.language,
        durationMs: model.durationMs,
        dimensions: model.dimensions,
        tokenCount: model.tokenCount,
        processedChunks: model.processedChunks,
        skippedChunks: model.skippedChunks,
        writtenChunks: model.writtenChunks,
        discardedChunks: model.discardedChunks,
        failedChunks: model.failedChunks,
        errorCode: model.errorCode,
      });
      if (model.errorCode !== null) {
        failureLogged = true;
        output.write(`  错误 [${model.errorCode}]：${model.errorMessage}\n`);
      }
    }
    output.write(
      `Embedding 完成：处理 ${result.processedChunks}，跳过 ${result.skippedChunks}，` +
        `写入 ${result.writtenChunks}，丢弃 ${result.discardedChunks}，` +
        `失败 ${result.failedChunks}，耗时 ${(performance.now() - startedAt).toFixed(1)} ms。\n`,
    );
    if (result.failedChunks > 0) {
      throw new AppError(
        "EMBEDDING_GENERATION_FAILED",
        "部分 Chunk 的 Embedding 生成失败；已成功写入的向量已保留，可稍后重试。",
      );
    }
  } catch (error) {
    const applicationError = asAppError(error);
    if (logger !== null && !failureLogged) {
      await logger.write({
        operation: "index-embed",
        status: "failed",
        modelId: null,
        language: null,
        durationMs: performance.now() - startedAt,
        dimensions: null,
        tokenCount: 0,
        processedChunks: 0,
        skippedChunks: 0,
        writtenChunks: 0,
        discardedChunks: 0,
        failedChunks: 0,
        errorCode: applicationError.code,
      });
    }
    throw error;
  } finally {
    removeInterrupt();
    await logger?.close();
  }
}

async function semanticSearch(
  materials: RagMaterialService,
  projectRoot: string,
  query: string,
  limit: number,
  debug: boolean,
  output: CommandOutput,
): Promise<void> {
  const logger = debug ? await RagDebugFileLogger.create(projectRoot) : null;
  if (logger !== null) output.write(`RAG Debug 日志：${logger.filePath}\n`);
  const startedAt = performance.now();
  try {
    const search = await materials.searchSemantic(query, limit);
    output.write(
      `语义检索：${search.language}\t${search.modelId}\t${search.tokenCount} tokens` +
        `\t${search.dimensions} dimensions\n`,
    );
    printResults(search.results, output, true);
    await logger?.write({
      operation: "semantic-search",
      status: "completed",
      modelId: search.modelId,
      language: search.language,
      durationMs: performance.now() - startedAt,
      embeddingDurationMs: search.embeddingDurationMs,
      searchDurationMs: search.searchDurationMs,
      dimensions: search.dimensions,
      tokenCount: search.tokenCount,
      resultCount: search.results.length,
      errorCode: null,
    });
  } catch (error) {
    const applicationError = asAppError(error);
    await logger?.write({
      operation: "semantic-search",
      status: "failed",
      modelId: null,
      language: null,
      durationMs: performance.now() - startedAt,
      embeddingDurationMs: null,
      searchDurationMs: null,
      dimensions: null,
      tokenCount: null,
      resultCount: null,
      errorCode: applicationError.code,
    });
    throw error;
  } finally {
    await logger?.close();
  }
}

function printResults(
  results: readonly {
    sourceTitle: string;
    sourceId: string;
    chunkId: string;
    content: string;
    startOffset: number;
    endOffset: number;
    distance?: number;
  }[],
  output: CommandOutput,
  includeDistance = false,
): void {
  if (results.length === 0) {
    output.write("没有找到匹配的资料。\n");
    return;
  }
  for (const [index, result] of results.entries()) {
    output.write(
      `[${index + 1}] ${result.sourceTitle}` +
        `${includeDistance && result.distance !== undefined ? `\tdistance: ${result.distance.toFixed(6)}` : ""}\n` +
        `source: ${result.sourceId}\nchunk: ${result.chunkId}\n` +
        `range: ${result.startOffset}-${result.endOffset}\n${snippet(result.content)}\n\n`,
    );
  }
}

class EmbeddingProgressPrinter {
  private readonly last = new Map<string, number>();

  constructor(private readonly output: CommandOutput) {}

  print(event: {
    language: "zh" | "en";
    modelId: string;
    completedChunks: number;
    totalChunks: number;
  }): void {
    const previous = this.last.get(event.modelId) ?? 0;
    const step = Math.max(1, Math.ceil(event.totalChunks / 20));
    if (
      event.completedChunks !== 1 &&
      event.completedChunks !== event.totalChunks &&
      event.completedChunks - previous < step
    ) {
      return;
    }
    this.last.set(event.modelId, event.completedChunks);
    this.output.write(
      `Embedding ${event.language} ${event.modelId}：${event.completedChunks}/${event.totalChunks}\n`,
    );
  }
}

function installEmbeddingInterruptHandler(
  controller: AbortController,
  output: CommandOutput,
): () => void {
  const handler = (): void => {
    if (!controller.signal.aborted) {
      output.write("\n正在取消 Embedding…\n");
      controller.abort();
    }
  };
  process.once("SIGINT", handler);
  return () => process.off("SIGINT", handler);
}

function positiveIntegerOption(parsed: ParsedArguments, name: string): number | undefined {
  const value = optionString(parsed, name);
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) {
    throw new AppError("VALIDATION_ERROR", `--${name} 必须是正整数。`);
  }
  const parsedValue = Number(value);
  if (!Number.isSafeInteger(parsedValue) || parsedValue < 1) {
    throw new AppError("VALIDATION_ERROR", `--${name} 必须是正整数。`);
  }
  return parsedValue;
}

function resolveDebug(parsed: ParsedArguments, dependencies: RagCommandDependencies): boolean {
  return parsed.options.has("debug") ? optionBoolean(parsed, "debug") : dependencies.defaultDebug;
}

function snippet(content: string): string {
  const characters = Array.from(content);
  return characters.length <= 500 ? content : `${characters.slice(0, 500).join("")}…`;
}
