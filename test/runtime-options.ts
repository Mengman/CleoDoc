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

export const TEST_MATERIAL_OPTIONS = {
  database: TEST_DATABASE_OPTIONS,
  maxImportBytes: 10 * 1024 * 1024,
  chunking: {
    maxChunkChars: 800,
    splitSearchWindowRatio: 0.75,
  },
} as const;
