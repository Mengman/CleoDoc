import path from "node:path";

import type { SoftwareConfig } from "../../../packages/config/src/index.js";
import type {
  MaterialServiceOptions,
  MaterialTokenizerModel,
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
    tokenizerModels: {
      zh: createTokenizerModel(
        resolveEmbeddingModelDefinition("zh", config.rag.embedding.models.zh, resourceRoot),
      ),
      en: createTokenizerModel(
        resolveEmbeddingModelDefinition("en", config.rag.embedding.models.en, resourceRoot),
      ),
    },
  };
}

function createTokenizerModel(
  definition: ResolvedEmbeddingModelDefinition,
): MaterialTokenizerModel {
  return {
    modelId: definition.modelId,
    modelRevision: definition.revision,
    maxInputTokens: definition.maxInputTokens,
    async openTokenizer() {
      const { NodeLlamaCppEmbeddingTokenizer } =
        await import("../../../packages/rag/src/node-llama-cpp-embedding.js");
      return await NodeLlamaCppEmbeddingTokenizer.open(definition);
    },
  };
}
