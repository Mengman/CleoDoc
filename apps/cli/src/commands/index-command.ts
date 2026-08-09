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

export async function runIndexCommand(
  parsed: ParsedArguments,
  context: CliCommandContext,
): Promise<void> {
  await executeIndexCommand(parsed, createRagCommandDependencies(context));
}

export async function executeIndexCommand(
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

async function printIndexStatus(
  materials: RagMaterialService,
  output: RagCommandDependencies["output"],
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

async function rebuildIndex(
  materials: RagMaterialService,
  output: RagCommandDependencies["output"],
): Promise<void> {
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
  output: RagCommandDependencies["output"],
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

class EmbeddingProgressPrinter {
  private readonly last = new Map<string, number>();

  constructor(private readonly output: RagCommandDependencies["output"]) {}

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
  output: RagCommandDependencies["output"],
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

function resolveDebug(parsed: ParsedArguments, dependencies: RagCommandDependencies): boolean {
  return parsed.options.has("debug") ? optionBoolean(parsed, "debug") : dependencies.defaultDebug;
}
