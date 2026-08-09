import type {
  MaterialEmbeddingModel,
  MaterialEmbeddingTaskOptions,
} from "../packages/knowledge/src/material-types.js";

export const TEST_DATABASE_OPTIONS = { busyTimeoutMs: 5_000 } as const;

export const TEST_CONTEXT_POLICY = {
  contextWindowTokens: 1_000_000,
  reservedOutputTokens: 384_000,
  nextUserInputReserveTokens: 32_768,
  safetyMarginRatio: 0.05,
  softCompactionRatio: 0.75,
  hardCompactionRatio: 0.9,
} as const;

export const TEST_CHAT_OPTIONS = {
  database: TEST_DATABASE_OPTIONS,
  maxToolRounds: 8,
  defaultContextBudgetPolicy: TEST_CONTEXT_POLICY,
  compaction: {
    summaryTargetRatio: 0.01,
    summaryTargetMinTokens: 512,
    summaryTargetMaxTokens: 8_000,
    segmentSummaryMaxTokens: 2_000,
    segmentPayloadTargetRatio: 0.8,
    splitSearchWindowRatio: 0.6,
    resultMinLimitTokens: 2_048,
    resultMaxLimitTokens: 32_000,
    resultTargetMultiplier: 4,
  },
} as const;

export function createTestMaterialOptions(
  options: { maxInputTokens?: number; modelRevision?: string } = {},
) {
  const maxInputTokens = options.maxInputTokens ?? 800;
  const modelRevision = options.modelRevision ?? "test-v1";
  const embeddingModel = (language: "zh" | "en"): MaterialEmbeddingModel => ({
    modelId: `test-${language}-tokenizer`,
    modelName: `test/${language}-embedding`,
    modelRevision,
    maxInputTokens,
    async openTokenizer() {
      return {
        modelId: `test-${language}-tokenizer`,
        modelRevision,
        maxInputTokens,
        countDocumentTokens: (content: string) => Array.from(content).length,
        async dispose() {},
      };
    },
    async runEmbeddingTask({ chunks, onProgress, onBatch }: MaterialEmbeddingTaskOptions) {
      const results = chunks.map((chunk, index) => {
        onProgress?.({
          completedChunks: index + 1,
          totalChunks: chunks.length,
          chunkId: chunk.chunkId,
        });
        return {
          chunkId: chunk.chunkId,
          tokenCount: Array.from(chunk.content).length,
          vector: Float32Array.from([chunk.content.length, language === "zh" ? 1 : 2]),
        };
      });
      await onBatch?.(results);
    },
    async embedQuery(query: string) {
      return {
        tokenCount: Array.from(query).length,
        vector: Float32Array.from([query.length, language === "zh" ? 1 : 2]),
      };
    },
  });
  return {
    database: TEST_DATABASE_OPTIONS,
    maxImportBytes: 10 * 1024 * 1024,
    chunking: { splitSearchWindowRatio: 0.75 },
    languageDetection: { minBlockUnits: 50 },
    embeddingChunkBatchSize: 16,
    embeddingModels: { zh: embeddingModel("zh"), en: embeddingModel("en") },
  };
}

export const TEST_MATERIAL_OPTIONS = createTestMaterialOptions();
