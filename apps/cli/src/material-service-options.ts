import path from "node:path";

import type { SoftwareConfig } from "../../../packages/config/src/index.js";
import type {
  MaterialEmbeddingModel,
  MaterialServiceOptions,
} from "../../../packages/knowledge/src/index.js";
import { resolveEmbeddingModelDefinition } from "../../../packages/rag/src/index.js";
import type { ResolvedEmbeddingModelDefinition } from "../../../packages/rag/src/index.js";

export function createMaterialServiceOptions(
  config: SoftwareConfig,
  defaultConfigPath: string,
): MaterialServiceOptions {
  const resourceRoot = path.resolve(path.dirname(defaultConfigPath), "..");
  return {
    database: { busyTimeoutMs: config.database.busyTimeoutMs },
    maxImportBytes: config.materials.maxImportBytes,
    chunking: config.rag.chunking,
    languageDetection: config.rag.languageDetection,
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
        await import("../../../packages/rag/src/node-llama-cpp-embedding.js");
      return await NodeLlamaCppEmbeddingTokenizer.open(definition, { gpuAcceleration });
    },
    async runEmbeddingTask(options) {
      const { runEmbeddingWorkerTask } =
        await import("../../../packages/rag/src/embedding-worker-task.js");
      await runEmbeddingWorkerTask({ definition, gpuAcceleration, ...options });
    },
    async embedQuery(query) {
      const { NodeLlamaCppEmbeddingRuntime } =
        await import("../../../packages/rag/src/node-llama-cpp-embedding.js");
      const runtime = await NodeLlamaCppEmbeddingRuntime.open(definition, { gpuAcceleration });
      try {
        return await runtime.embedQuery(query);
      } finally {
        await runtime.dispose();
      }
    },
  };
}
