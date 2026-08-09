import { stat } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

import {
  getSoftwareConfig,
  getSoftwareDefaultConfigPath,
} from "../../../../packages/config/src/index.js";
import { AppError } from "../../../../packages/contracts/src/index.js";
import { resolveEmbeddingModelDefinition } from "../../../../packages/rag/src/embedding-model-definition.js";
import type { EmbeddingLanguage } from "../../../../packages/rag/src/embedding-types.js";
import { assertOnlyOptions, optionBoolean, type ParsedArguments } from "../arguments.js";
import type { CliCommandContext } from "./command-context.js";

export async function runEmbeddingCommand(
  parsed: ParsedArguments,
  context: CliCommandContext,
): Promise<void> {
  const config = getSoftwareConfig();
  const [subcommand, languageValue, text] = parsed.positionals;
  const resourceRoot = path.resolve(path.dirname(getSoftwareDefaultConfigPath()), "..");

  if (subcommand === "model") {
    assertOnlyOptions(parsed, []);
    if (parsed.positionals.length !== 1) {
      throw new AppError("VALIDATION_ERROR", "用法：cleo embedding model");
    }
    context.output.write(`GPU 加速：${config.gpuAcceleration ? "开启（auto）" : "关闭"}\n`);
    for (const language of ["zh", "en"] as const) {
      const definition = resolveEmbeddingModelDefinition(
        language,
        config.rag.embedding.models[language],
        resourceRoot,
      );
      const file = await stat(definition.modelPath).catch(() => null);
      context.output.write(
        `${language}\t${definition.modelId}\t${file?.isFile() === true ? formatBytes(file.size) : "缺失"}\t${definition.modelFile}\n`,
      );
    }
    return;
  }

  if (subcommand !== "test" || !isEmbeddingLanguage(languageValue) || text === undefined) {
    throw new AppError("VALIDATION_ERROR", "用法：cleo embedding test <zh|en> <text> [--query]");
  }
  assertOnlyOptions(parsed, ["query"]);
  if (parsed.positionals.length !== 3) {
    throw new AppError(
      "VALIDATION_ERROR",
      '测试文本包含空格时需要使用引号包裹：cleo embedding test <zh|en> "<text>"',
    );
  }

  const definition = resolveEmbeddingModelDefinition(
    languageValue,
    config.rag.embedding.models[languageValue],
    resourceRoot,
  );
  const startedAt = performance.now();
  const { NodeLlamaCppEmbeddingRuntime } =
    await import("../../../../packages/rag/src/node-llama-cpp-embedding.js");
  const runtime = await NodeLlamaCppEmbeddingRuntime.open(definition, {
    gpuAcceleration: config.gpuAcceleration,
  });
  try {
    const query = optionBoolean(parsed, "query");
    const result = query ? await runtime.embedQuery(text) : await runtime.embedDocument(text);
    context.output.write(`模型：${runtime.info.modelId}\n`);
    context.output.write(`输入：${query ? "query" : "document"}\n`);
    context.output.write(`Token：${result.tokenCount}/${runtime.info.maxInputTokens}\n`);
    context.output.write(`向量维度：${result.vector.length}\n`);
    context.output.write(`向量范数：${vectorNorm(result.vector).toFixed(6)}\n`);
    context.output.write(`总耗时：${(performance.now() - startedAt).toFixed(1)} ms\n`);
    for (const warning of runtime.info.modelWarnings) {
      context.output.write(`模型警告：${warning}\n`);
    }
  } finally {
    await runtime.dispose();
  }
}

function isEmbeddingLanguage(value: string | undefined): value is EmbeddingLanguage {
  return value === "zh" || value === "en";
}

function vectorNorm(vector: Float32Array): number {
  let squared = 0;
  for (const value of vector) squared += value * value;
  return Math.sqrt(squared);
}

function formatBytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}
