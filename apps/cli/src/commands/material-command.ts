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

export type MaterialCommandService = Pick<
  MaterialService,
  "addFile" | "addText" | "get" | "list" | "remove" | "rename"
>;

export async function runMaterialCommand(
  parsed: ParsedArguments,
  context: CliCommandContext,
): Promise<void> {
  const config = getSoftwareConfig();
  const root = await resolveProjectRoot(context, optionString(parsed, "project"));
  const materials = await MaterialService.open(root, createMaterialServiceOptions());
  try {
    await executeMaterialCommand(parsed, context, materials, config.materials.maxImportBytes);
  } finally {
    await materials.close();
  }
}

export async function executeMaterialCommand(
  parsed: ParsedArguments,
  context: CliCommandContext,
  materials: MaterialCommandService,
  maxImportBytes: number,
): Promise<void> {
  const [subcommand, reference, value] = parsed.positionals;
  assertOnlyOptions(parsed, ["project", "stdin", "title", "format", "encoding"]);
  switch (subcommand) {
    case "add":
      await addMaterial(parsed, context, materials, reference, maxImportBytes);
      return;
    case "list":
      assertPositionals(parsed, 1, "cleo material list");
      assertOnlyOptions(parsed, ["project"]);
      await listMaterials(context, materials);
      return;
    case "show": {
      assertPositionals(parsed, 2, "cleo material show <title>");
      assertOnlyOptions(parsed, ["project"]);
      const source = await findMaterialByTitle(materials, reference!);
      const material = await materials.get(source.id);
      printMaterialMetadata(context, material.source);
      context.output.write("--- 内容 ---\n");
      context.output.write(material.content);
      if (!material.content.endsWith("\n")) context.output.write("\n");
      return;
    }
    case "rename": {
      assertPositionals(parsed, 3, "cleo material rename <current-title> <new-title>");
      assertOnlyOptions(parsed, ["project"]);
      const source = await findMaterialByTitle(materials, reference!);
      const renamed = await materials.rename(source.id, value!);
      context.output.write(`已重命名资料：${renamed.title}\n`);
      return;
    }
    case "remove": {
      assertPositionals(parsed, 2, "cleo material remove <title>");
      assertOnlyOptions(parsed, ["project"]);
      const source = await findMaterialByTitle(materials, reference!);
      const removed = await materials.remove(source.id);
      context.output.write(`已删除资料：${removed.title}\n`);
      return;
    }
    default:
      throw new AppError("VALIDATION_ERROR", "用法：cleo material <add|list|show|rename|remove>");
  }
}

async function addMaterial(
  parsed: ParsedArguments,
  context: CliCommandContext,
  materials: MaterialCommandService,
  reference: string | undefined,
  maxImportBytes: number,
): Promise<void> {
  const fromStdin = optionBoolean(parsed, "stdin");
  const title = optionString(parsed, "title");
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
    ...(requestedEncoding === undefined
      ? {}
      : { encoding: parseMaterialEncodingLabel(requestedEncoding) }),
  });
  printMaterialImported(context, result);
}

async function listMaterials(
  context: CliCommandContext,
  materials: MaterialCommandService,
): Promise<void> {
  const list = await materials.list();
  if (list.length === 0) context.output.write("尚无资料。\n");
  for (const source of list) {
    context.output.write(
      `${source.title}\t${source.format}\t${source.languages.join(",")}\t${source.size} bytes\n`,
    );
  }
}

async function findMaterialByTitle(
  materials: MaterialCommandService,
  title: string,
): Promise<Awaited<ReturnType<MaterialCommandService["list"]>>[number]> {
  const normalizedTitle = title.trim();
  const source = (await materials.list()).find((candidate) => candidate.title === normalizedTitle);
  if (source === undefined) {
    throw new AppError("MATERIAL_NOT_FOUND", `当前项目中找不到资料：${normalizedTitle}`);
  }
  return source;
}

function assertPositionals(parsed: ParsedArguments, expected: number, usage: string): void {
  if (parsed.positionals.length !== expected) {
    throw new AppError("VALIDATION_ERROR", `用法：${usage}`);
  }
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
  context.output.write(`路径：${result.source.relativePath}\n`);
  context.output.write(`输入编码：${result.inputEncoding}\n`);
  context.output.write(`语言：${result.source.languages.join(", ")}\n`);
}

function printMaterialMetadata(
  context: CliCommandContext,
  source: Awaited<ReturnType<MaterialService["list"]>>[number],
): void {
  context.output.write(`资料：${source.title}\n`);
  context.output.write(`格式：${source.format}\n`);
  context.output.write(`语言：${source.languages.join(", ")}\n`);
  context.output.write(`路径：${source.relativePath}\n`);
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
