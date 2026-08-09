import { readFile, stat } from "node:fs/promises";

import {
  getLlama,
  LlamaVocabularyType,
  type Llama,
  type LlamaEmbeddingContext,
  type LlamaModel,
  type Token,
} from "node-llama-cpp";

import { AppError } from "../../contracts/src/index.js";
import { formatEmbeddingInput } from "./embedding-model-definition.js";
import { resolveEmbeddingLlamaBackend } from "./embedding-platform.js";
import type {
  EmbeddingInputKind,
  EmbeddingResult,
  EmbeddingRuntimeInfo,
  EmbeddingTokenizer,
  ResolvedEmbeddingModelDefinition,
} from "./embedding-types.js";

export class NodeLlamaCppEmbeddingRuntime implements EmbeddingTokenizer {
  readonly modelId: string;
  readonly modelRevision: string;
  readonly maxInputTokens: number;
  private disposed = false;

  private constructor(
    private readonly definition: ResolvedEmbeddingModelDefinition,
    private readonly llama: Llama,
    private readonly model: LlamaModel,
    private readonly context: LlamaEmbeddingContext,
  ) {
    this.modelId = definition.modelId;
    this.modelRevision = definition.revision;
    this.maxInputTokens = definition.maxInputTokens;
  }

  static async open(
    definition: ResolvedEmbeddingModelDefinition,
  ): Promise<NodeLlamaCppEmbeddingRuntime> {
    await assertUsableModelFile(definition);
    let llama: Llama | undefined;
    let model: LlamaModel | undefined;
    try {
      llama = await getLlama({
        gpu: resolveEmbeddingLlamaBackend(),
        build: "never",
        skipDownload: true,
        progressLogs: false,
        logger: () => undefined,
      });
      model = await llama.loadModel({
        modelPath: definition.modelPath,
        gpuLayers: 0,
        useMmap: true,
      });
      if (definition.maxInputTokens > model.trainContextSize) {
        throw new AppError(
          "CONFIG_ERROR",
          `配置的最大输入长度 ${definition.maxInputTokens} 超过模型能力 ${model.trainContextSize}。`,
        );
      }
      if (model.embeddingVectorSize < 1) {
        throw new AppError("EMBEDDING_MODEL_LOAD_FAILED", "GGUF 模型不支持 Embedding。", {
          details: { modelId: definition.modelId },
        });
      }
      const context = await model.createEmbeddingContext({
        contextSize: definition.maxInputTokens,
        batchSize: definition.maxInputTokens,
        threads: llama.maxThreads,
      });
      return new NodeLlamaCppEmbeddingRuntime(definition, llama, model, context);
    } catch (error) {
      await model?.dispose().catch(() => undefined);
      await llama?.dispose().catch(() => undefined);
      if (error instanceof AppError) throw error;
      throw new AppError("EMBEDDING_MODEL_LOAD_FAILED", "无法加载本地 Embedding 模型。", {
        cause: error,
        details: { modelId: definition.modelId },
      });
    }
  }

  get info(): EmbeddingRuntimeInfo {
    this.assertActive();
    return {
      modelId: this.definition.modelId,
      modelName: this.definition.modelName,
      revision: this.definition.revision,
      language: this.definition.language,
      modelPath: this.definition.modelPath,
      maxInputTokens: this.definition.maxInputTokens,
      embeddingDimensions: this.model.embeddingVectorSize,
      modelWarnings: this.model
        .getWarnings()
        .map((warning) => warning.replaceAll(this.definition.modelPath, this.definition.modelFile)),
    };
  }

  countDocumentTokens(content: string): number {
    return this.countInputTokens("document", content);
  }

  countQueryTokens(query: string): number {
    return this.countInputTokens("query", query);
  }

  async embedDocument(content: string): Promise<EmbeddingResult> {
    return await this.embed("document", content);
  }

  async embedQuery(query: string): Promise<EmbeddingResult> {
    return await this.embed("query", query);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    try {
      await this.context.dispose();
    } finally {
      try {
        await this.model.dispose();
      } finally {
        await this.llama.dispose();
      }
    }
  }

  private countInputTokens(kind: EmbeddingInputKind, content: string): number {
    this.assertActive();
    const input = formatEmbeddingInput(this.definition, kind, content);
    return countEvaluationTokens(this.model, input);
  }

  private async embed(kind: EmbeddingInputKind, content: string): Promise<EmbeddingResult> {
    this.assertActive();
    const input = formatEmbeddingInput(this.definition, kind, content);
    const tokenCount = countEvaluationTokens(this.model, input);
    if (tokenCount > this.maxInputTokens) {
      throw new AppError(
        "EMBEDDING_INPUT_TOO_LONG",
        `Embedding 输入为 ${tokenCount} Token，超过模型上限 ${this.maxInputTokens}。`,
        { details: { modelId: this.modelId, tokenCount, maxInputTokens: this.maxInputTokens } },
      );
    }
    let result: Awaited<ReturnType<LlamaEmbeddingContext["getEmbeddingFor"]>>;
    try {
      result = await this.context.getEmbeddingFor(input);
    } catch (error) {
      throw new AppError("EMBEDDING_GENERATION_FAILED", "本地 Embedding 推理失败。", {
        cause: error,
        details: { modelId: this.modelId },
      });
    }
    const vector = normalizeVector(result.vector, this.modelId);
    if (vector.length !== this.model.embeddingVectorSize) {
      throw new AppError("EMBEDDING_MODEL_LOAD_FAILED", "Embedding 向量维度与模型声明不一致。", {
        details: { modelId: this.modelId },
      });
    }
    return { vector, tokenCount };
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new AppError("EMBEDDING_MODEL_LOAD_FAILED", "Embedding 运行时已经关闭。", {
        details: { modelId: this.modelId },
      });
    }
  }
}

export class NodeLlamaCppEmbeddingTokenizer implements EmbeddingTokenizer {
  readonly modelId: string;
  readonly modelRevision: string;
  readonly maxInputTokens: number;
  private disposed = false;

  private constructor(
    private readonly definition: ResolvedEmbeddingModelDefinition,
    private readonly llama: Llama,
    private readonly model: LlamaModel,
  ) {
    this.modelId = definition.modelId;
    this.modelRevision = definition.revision;
    this.maxInputTokens = definition.maxInputTokens;
  }

  static async open(
    definition: ResolvedEmbeddingModelDefinition,
  ): Promise<NodeLlamaCppEmbeddingTokenizer> {
    await assertUsableModelFile(definition);
    let llama: Llama | undefined;
    let model: LlamaModel | undefined;
    try {
      llama = await getLlama({
        gpu: resolveEmbeddingLlamaBackend(),
        build: "never",
        skipDownload: true,
        progressLogs: false,
        logger: () => undefined,
      });
      model = await llama.loadModel({
        modelPath: definition.modelPath,
        gpuLayers: 0,
        useMmap: true,
        vocabOnly: true,
      });
      return new NodeLlamaCppEmbeddingTokenizer(definition, llama, model);
    } catch (error) {
      await model?.dispose().catch(() => undefined);
      await llama?.dispose().catch(() => undefined);
      if (error instanceof AppError) throw error;
      throw new AppError("EMBEDDING_MODEL_LOAD_FAILED", "无法加载 Embedding Tokenizer。", {
        cause: error,
        details: { modelId: definition.modelId },
      });
    }
  }

  countDocumentTokens(content: string): number {
    return this.countInputTokens("document", content);
  }

  countQueryTokens(query: string): number {
    return this.countInputTokens("query", query);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    try {
      await this.model.dispose();
    } finally {
      await this.llama.dispose();
    }
  }

  private countInputTokens(kind: EmbeddingInputKind, content: string): number {
    if (this.disposed) {
      throw new AppError("EMBEDDING_MODEL_LOAD_FAILED", "Embedding Tokenizer 已经关闭。", {
        details: { modelId: this.modelId },
      });
    }
    return countEvaluationTokens(this.model, formatEmbeddingInput(this.definition, kind, content));
  }
}

function normalizeVector(vector: readonly number[], modelId: string): Float32Array {
  let squaredNorm = 0;
  for (const value of vector) {
    if (!Number.isFinite(value)) {
      throw new AppError("EMBEDDING_GENERATION_FAILED", "Embedding 向量包含无效数值。", {
        details: { modelId },
      });
    }
    squaredNorm += value * value;
  }
  const norm = Math.sqrt(squaredNorm);
  if (norm === 0) {
    throw new AppError("EMBEDDING_GENERATION_FAILED", "Embedding 模型返回了零向量。", {
      details: { modelId },
    });
  }
  return Float32Array.from(vector, (value) => value / norm);
}

function countEvaluationTokens(model: LlamaModel, content: string): number {
  const tokens = model.tokenize(content);
  const beginning = beginningToken(model);
  const end = endToken(model);
  return (
    tokens.length +
    (beginning !== null && tokens[0] !== beginning ? 1 : 0) +
    (end !== null && tokens.at(-1) !== end ? 1 : 0)
  );
}

function beginningToken(model: LlamaModel): Token | null {
  if (model.vocabularyType === LlamaVocabularyType.rwkv) return null;
  if (model.vocabularyType === LlamaVocabularyType.wpm) return model.tokens.bos;
  if (model.vocabularyType === LlamaVocabularyType.ugm) return null;
  return model.tokens.shouldPrependBosToken ? model.tokens.bos : null;
}

function endToken(model: LlamaModel): Token | null {
  if (model.vocabularyType === LlamaVocabularyType.rwkv) return null;
  if (model.vocabularyType === LlamaVocabularyType.wpm) return model.tokens.sep;
  if (model.vocabularyType === LlamaVocabularyType.ugm) return model.tokens.eos;
  return model.tokens.shouldAppendEosToken ? model.tokens.eos : null;
}

async function assertUsableModelFile(definition: ResolvedEmbeddingModelDefinition): Promise<void> {
  const file = await stat(definition.modelPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      throw new AppError("EMBEDDING_MODEL_NOT_FOUND", "找不到本地 Embedding 模型。", {
        details: { modelId: definition.modelId, modelFile: definition.modelFile },
      });
    }
    throw error;
  });
  if (!file.isFile()) {
    throw new AppError("EMBEDDING_MODEL_NOT_FOUND", "Embedding 模型路径不是文件。", {
      details: { modelId: definition.modelId, modelFile: definition.modelFile },
    });
  }
  if (file.size < 1_024) {
    const prefix = await readFile(definition.modelPath, { encoding: "utf8" }).catch(() => "");
    const message = prefix.startsWith("version https://git-lfs.github.com/spec/v1")
      ? "Embedding 模型仍是 Git LFS 指针，请先执行 git lfs pull。"
      : "Embedding 模型文件过小，可能不完整。";
    throw new AppError("EMBEDDING_MODEL_NOT_FOUND", message, {
      details: { modelId: definition.modelId, modelFile: definition.modelFile },
    });
  }
}
