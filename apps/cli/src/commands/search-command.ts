import { performance } from "node:perf_hooks";

import { AppError, asAppError } from "../../../../packages/contracts/src/index.js";
import {
  assertOnlyOptions,
  optionBoolean,
  optionString,
  type ParsedArguments,
} from "../arguments.js";
import { RagDebugFileLogger } from "./rag-debug-log.js";
import type { CliCommandContext } from "./command-context.js";
import { createRagCommandDependencies } from "./rag-command-dependencies.js";
import type { RagCommandDependencies, RagMaterialService } from "./rag-command-types.js";

export async function runSearchCommand(
  parsed: ParsedArguments,
  context: CliCommandContext,
): Promise<void> {
  await executeSearchCommand(parsed, createRagCommandDependencies(context));
}

export async function executeSearchCommand(
  parsed: ParsedArguments,
  dependencies: RagCommandDependencies,
): Promise<void> {
  assertOnlyOptions(parsed, [
    "project",
    "limit",
    "scope",
    "semantic",
    "hybrid",
    "explain",
    "debug",
  ]);
  const [query] = parsed.positionals;
  if (query === undefined || parsed.positionals.length !== 1) {
    throw new AppError(
      "VALIDATION_ERROR",
      "用法：cleo search <query> [--semantic|--hybrid] [--explain] [--limit <数量>]",
    );
  }
  const scope = optionString(parsed, "scope") ?? "material";
  if (scope !== "material") {
    throw new AppError("VALIDATION_ERROR", "当前检索只支持 --scope material。");
  }
  const semantic = optionBoolean(parsed, "semantic");
  const hybrid = optionBoolean(parsed, "hybrid");
  const explain = optionBoolean(parsed, "explain");
  if (semantic && hybrid) {
    throw new AppError("VALIDATION_ERROR", "--semantic 和 --hybrid 不能同时使用。");
  }
  if (explain && !hybrid) {
    throw new AppError("VALIDATION_ERROR", "--explain 只能与 --hybrid 一起使用。");
  }
  const explicitDebug = parsed.options.has("debug");
  if (explicitDebug && !semantic && !hybrid) {
    throw new AppError("VALIDATION_ERROR", "--debug 当前只用于 --semantic 或 --hybrid 检索。");
  }
  const debug = (semantic || hybrid) && resolveDebug(parsed, dependencies);
  const limit = positiveIntegerOption(parsed, "limit") ?? 10;
  if (limit > 100) throw new AppError("VALIDATION_ERROR", "--limit 不能超过 100。");
  const root = await dependencies.resolveProjectRoot(optionString(parsed, "project"));
  const materials = await dependencies.openMaterials(root);
  try {
    if (hybrid) {
      await hybridSearch(materials, root, query, limit, explain, debug, dependencies.output);
      return;
    }
    if (!semantic) {
      printResults(await materials.search(query, limit), dependencies.output);
      return;
    }
    await semanticSearch(materials, root, query, limit, debug, dependencies.output);
  } finally {
    await materials.close();
  }
}

async function hybridSearch(
  materials: RagMaterialService,
  projectRoot: string,
  query: string,
  limit: number,
  explain: boolean,
  debug: boolean,
  output: RagCommandDependencies["output"],
): Promise<void> {
  const logger = debug ? await RagDebugFileLogger.create(projectRoot) : null;
  if (logger !== null) output.write(`RAG Debug 日志：${logger.filePath}\n`);
  const startedAt = performance.now();
  try {
    const search = await materials.searchHybrid(query, { limit });
    output.write(
      `混合检索：${search.language}\t${search.embeddingModelId}` +
        `\texact ${search.exactCandidateCount}` +
        `\tfts ${search.ftsCandidateCount}` +
        `\tvector ${search.vectorCandidateCount}\n`,
    );
    if (search.vectorErrorCode !== null) {
      output.write(`向量检索不可用，已使用 Exact + FTS：${search.vectorErrorCode}\n`);
    }
    printHybridResults(search.retrievalContext.items, output, explain);
    if (explain) {
      output.write(`上下文字符数：${search.retrievalContext.contentCharacterCount}\n`);
    }
    await logger?.write({
      operation: "hybrid-search",
      status: "completed",
      modelId: search.embeddingModelId,
      language: search.language,
      durationMs: performance.now() - startedAt,
      embeddingDurationMs: search.embeddingDurationMs,
      exactCandidateCount: search.exactCandidateCount,
      ftsCandidateCount: search.ftsCandidateCount,
      vectorCandidateCount: search.vectorCandidateCount,
      resultCount: search.retrievalContext.items.length,
      vectorErrorCode: search.vectorErrorCode,
      errorCode: null,
    });
  } catch (error) {
    const applicationError = asAppError(error);
    await logger?.write({
      operation: "hybrid-search",
      status: "failed",
      modelId: null,
      language: null,
      durationMs: performance.now() - startedAt,
      embeddingDurationMs: null,
      exactCandidateCount: null,
      ftsCandidateCount: null,
      vectorCandidateCount: null,
      resultCount: null,
      vectorErrorCode: null,
      errorCode: applicationError.code,
    });
    throw error;
  } finally {
    await logger?.close();
  }
}

async function semanticSearch(
  materials: RagMaterialService,
  projectRoot: string,
  query: string,
  limit: number,
  debug: boolean,
  output: RagCommandDependencies["output"],
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
    printVectorResults(search.results, output);
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
    chunkId: string;
    content: string;
    startOffset: number;
    endOffset: number;
  }[],
  output: RagCommandDependencies["output"],
): void {
  if (results.length === 0) {
    output.write("没有找到匹配的资料。\n");
    return;
  }
  for (const [index, result] of results.entries()) {
    output.write(
      `[${index + 1}] ${result.sourceTitle}` +
        `\n` +
        `chunk: ${result.chunkId}\n` +
        `range: ${result.startOffset}-${result.endOffset}\n${snippet(result.content)}\n\n`,
    );
  }
}

function printVectorResults(
  results: Awaited<ReturnType<RagMaterialService["searchSemantic"]>>["results"],
  output: RagCommandDependencies["output"],
): void {
  if (results.length === 0) {
    output.write("没有找到匹配的资料。\n");
    return;
  }
  for (const [index, result] of results.entries()) {
    const chunk = result.chunk;
    output.write(
      `[${index + 1}] ${chunk.sourceTitle}\tdistance: ${result.distance.toFixed(6)}\n` +
        `chunk: ${chunk.chunkId}\n` +
        `range: ${chunk.startOffset}-${chunk.endOffset}\n${snippet(chunk.content)}\n\n`,
    );
  }
}

function printHybridResults(
  results: Awaited<ReturnType<RagMaterialService["searchHybrid"]>>["retrievalContext"]["items"],
  output: RagCommandDependencies["output"],
  explain: boolean,
): void {
  if (results.length === 0) {
    output.write("没有找到匹配的资料。\n");
    return;
  }
  for (const [index, result] of results.entries()) {
    const chunk = result.chunk;
    const ranks = result.ranks.map((rank) => `${rank.method}#${rank.rank}`).join(", ");
    output.write(
      `[${index + 1}] ${chunk.sourceTitle}\tscore: ${result.score.toFixed(6)}\n` +
        `chunk: ${chunk.chunkId}\n` +
        `range: ${chunk.startOffset}-${chunk.endOffset}\n` +
        (explain ? `命中：${ranks}\n资料版本时间：${chunk.sourceUpdatedAt}\n` : "") +
        `${snippet(chunk.content)}\n\n`,
    );
  }
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
