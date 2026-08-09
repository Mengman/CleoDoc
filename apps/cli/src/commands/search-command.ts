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
  if (limit > 100) throw new AppError("VALIDATION_ERROR", "--limit 不能超过 100。");
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
  output: RagCommandDependencies["output"],
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
