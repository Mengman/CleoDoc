import path from "node:path";
import { TextDecoder } from "node:util";

import {
  getSoftwareConfig,
  getSoftwareDefaultConfigPath,
} from "../../../../packages/config/src/index.js";
import { AppError } from "../../../../packages/contracts/src/index.js";
import {
  type MaterialEmbeddingModel,
  MaterialService,
  type MaterialServiceOptions,
  parseMaterialEncodingLabel,
} from "../../../../packages/knowledge/src/index.js";
import {
  resolveEmbeddingModelDefinition,
  type ResolvedEmbeddingModelDefinition,
} from "../../../../packages/rag/src/index.js";
import {
  assertOnlyOptions,
  optionBoolean,
  optionString,
  type ParsedArguments,
} from "../arguments.js";
import { resolveProjectRoot, type CliCommandContext } from "./command-context.js";

export async function runMaterialCommand(
  parsed: ParsedArguments,
  context: CliCommandContext,
): Promise<void> {
  const config = getSoftwareConfig();
  const [subcommand, reference, value] = parsed.positionals;
  assertOnlyOptions(parsed, ["project", "stdin", "title", "tags", "format", "encoding"]);
  const root = await resolveProjectRoot(context, optionString(parsed, "project"));
  const materials = await MaterialService.open(root, createMaterialServiceOptions());
  try {
    switch (subcommand) {
      case "add":
        await addMaterial(parsed, context, materials, reference, config.materials.maxImportBytes);
        return;
      case "list":
        assertPositionals(parsed, 1, "cleo material list");
        assertOnlyOptions(parsed, ["project"]);
        await listMaterials(context, materials);
        return;
      case "show": {
        assertPositionals(parsed, 2, "cleo material show <material-id>");
        assertOnlyOptions(parsed, ["project"]);
        const material = await materials.get(reference!);
        printMaterialMetadata(context, material.source);
        context.output.write("--- 内容 ---\n");
        context.output.write(material.content);
        if (!material.content.endsWith("\n")) context.output.write("\n");
        return;
      }
      case "rename": {
        assertPositionals(parsed, 3, "cleo material rename <material-id> <title>");
        assertOnlyOptions(parsed, ["project"]);
        const renamed = await materials.rename(reference!, value!);
        context.output.write(`已重命名资料：${renamed.title}（${renamed.id}）\n`);
        return;
      }
      case "remove": {
        assertPositionals(parsed, 2, "cleo material remove <material-id>");
        assertOnlyOptions(parsed, ["project"]);
        const removed = await materials.remove(reference!);
        context.output.write(`已删除资料：${removed.title}（${removed.id}）\n`);
        return;
      }
      default:
        throw new AppError("VALIDATION_ERROR", "用法：cleo material <add|list|show|rename|remove>");
    }
  } finally {
    await materials.close();
  }
}

async function addMaterial(
  parsed: ParsedArguments,
  context: CliCommandContext,
  materials: MaterialService,
  reference: string | undefined,
  maxImportBytes: number,
): Promise<void> {
  const fromStdin = optionBoolean(parsed, "stdin");
  const title = optionString(parsed, "title");
  const tags = parseTags(optionString(parsed, "tags"));
  const requestedFormat = optionString(parsed, "format");
  const requestedEncoding = optionString(parsed, "encoding");
  if (fromStdin) {
    if (reference !== undefined || parsed.positionals.length !== 1) {
      throw new AppError("VALIDATION_ERROR", "用法：cleo material add --stdin [选项]");
    }
    if (requestedFormat !== undefined && !["text", "markdown"].includes(requestedFormat)) {
      throw new AppError("VALIDATION_ERROR", "--format 只能是 text 或 markdown。");
    }
    if (requestedEncoding !== undefined) {
      throw new AppError("VALIDATION_ERROR", "--encoding 当前只用于文件导入。");
    }
    const result = await materials.addText(await readStandardInput(context, maxImportBytes), {
      ...(title === undefined ? {} : { title }),
      ...(tags.length === 0 ? {} : { tags }),
      ...(requestedFormat === undefined ? {} : { format: requestedFormat as "text" | "markdown" }),
    });
    printMaterialImported(context, result);
    return;
  }
  if (reference === undefined || parsed.positionals.length !== 2) {
    throw new AppError("VALIDATION_ERROR", "用法：cleo material add <file> [选项]");
  }
  if (requestedFormat !== undefined) {
    throw new AppError("VALIDATION_ERROR", "导入文件时由扩展名决定格式，不能使用 --format。");
  }
  const result = await materials.addFile(reference, {
    ...(title === undefined ? {} : { title }),
    ...(tags.length === 0 ? {} : { tags }),
    ...(requestedEncoding === undefined
      ? {}
      : { encoding: parseMaterialEncodingLabel(requestedEncoding) }),
  });
  printMaterialImported(context, result);
}

async function listMaterials(
  context: CliCommandContext,
  materials: MaterialService,
): Promise<void> {
  const list = await materials.list();
  if (list.length === 0) context.output.write("尚无资料。\n");
  for (const source of list) {
    context.output.write(
      `${source.id}\t${source.title}\t${source.format}\t${source.languages.join(",")}\t${source.size} bytes\t${source.tags.join(",")}\n`,
    );
  }
}

function assertPositionals(parsed: ParsedArguments, expected: number, usage: string): void {
  if (parsed.positionals.length !== expected) {
    throw new AppError("VALIDATION_ERROR", `用法：${usage}`);
  }
}

function parseTags(value: string | undefined): string[] {
  return value === undefined ? [] : value.split(",").map((tag) => tag.trim());
}

async function readStandardInput(
  context: CliCommandContext,
  maxImportBytes: number,
): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of context.input) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.byteLength;
    if (size > maxImportBytes) {
      throw new AppError("VALIDATION_ERROR", "标准输入资料超过了软件配置允许的大小。");
    }
    chunks.push(buffer);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch (error) {
    throw new AppError("VALIDATION_ERROR", "标准输入资料必须是有效的 UTF-8 文本。", {
      cause: error,
    });
  }
}

function printMaterialImported(
  context: CliCommandContext,
  result: Awaited<ReturnType<MaterialService["addText"]>>,
): void {
  context.output.write(
    `${result.created ? "已添加资料" : "资料已存在，未重复导入"}：${result.source.title}\n`,
  );
  context.output.write(`资料 ID：${result.source.id}\n路径：${result.source.relativePath}\n`);
  context.output.write(`输入编码：${result.inputEncoding}\n`);
  context.output.write(`语言：${result.source.languages.join(", ")}\n`);
  if (result.created) {
    context.output.write(`解析结果：.cleo/derived/documents/${result.source.id}.cdm.xml\n`);
    context.output.write(`切片结果：.cleo/derived/chunks/${result.source.id}.chunks.json\n`);
  }
  context.output.write(`内容哈希：${result.source.contentHash}\n`);
}

function printMaterialMetadata(
  context: CliCommandContext,
  source: Awaited<ReturnType<MaterialService["list"]>>[number],
): void {
  context.output.write(`资料：${source.title}\n`);
  context.output.write(`资料 ID：${source.id}\n`);
  context.output.write(`格式：${source.format}\n`);
  context.output.write(`语言：${source.languages.join(", ")}\n`);
  context.output.write(`标签：${source.tags.length === 0 ? "无" : source.tags.join(", ")}\n`);
  context.output.write(`路径：${source.relativePath}\n内容哈希：${source.contentHash}\n`);
  context.output.write(`创建时间：${source.createdAt}\n更新时间：${source.updatedAt}\n`);
}

export function createMaterialServiceOptions(): MaterialServiceOptions {
  const config = getSoftwareConfig();
  const resourceRoot = path.resolve(path.dirname(getSoftwareDefaultConfigPath()), "..");
  return {
    database: { busyTimeoutMs: config.database.busyTimeoutMs },
    maxImportBytes: config.materials.maxImportBytes,
    chunking: config.rag.chunking,
    languageDetection: config.rag.languageDetection,
    retrieval: config.rag.retrieval,
    embeddingChunkBatchSize: config.rag.embedding.worker.chunkBatchSize,
    embeddingModels: {
      zh: createEmbeddingModel(
        resolveEmbeddingModelDefinition("zh", config.rag.embedding.models.zh, resourceRoot),
        config.gpuAcceleration,
      ),
      en: createEmbeddingModel(
        resolveEmbeddingModelDefinition("en", config.rag.embedding.models.en, resourceRoot),
        config.gpuAcceleration,
      ),
    },
  };
}

function createEmbeddingModel(
  definition: ResolvedEmbeddingModelDefinition,
  gpuAcceleration: boolean,
): MaterialEmbeddingModel {
  return {
    modelId: definition.modelId,
    modelName: definition.modelName,
    modelRevision: definition.revision,
    maxInputTokens: definition.maxInputTokens,
    async openTokenizer() {
      const { NodeLlamaCppEmbeddingTokenizer } =
        await import("../../../../packages/rag/src/node-llama-cpp-embedding.js");
      return await NodeLlamaCppEmbeddingTokenizer.open(definition, { gpuAcceleration });
    },
    async runEmbeddingTask(options) {
      const { runEmbeddingWorkerTask } =
        await import("../../../../packages/rag/src/embedding-worker-task.js");
      await runEmbeddingWorkerTask({ definition, gpuAcceleration, ...options });
    },
    async embedQuery(query) {
      const { NodeLlamaCppEmbeddingRuntime } =
        await import("../../../../packages/rag/src/node-llama-cpp-embedding.js");
      const runtime = await NodeLlamaCppEmbeddingRuntime.open(definition, { gpuAcceleration });
      try {
        return await runtime.embedQuery(query);
      } finally {
        await runtime.dispose();
      }
    },
  };
}
