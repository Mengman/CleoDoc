import { z } from "zod";

const positiveInteger = z.number().int().positive();
const positiveRatio = z.number().positive().max(1);

export const modelCapabilitiesSchema = z
  .object({
    displayName: z.string().trim().min(1),
    contextWindowTokens: z.number().int().min(2_048),
    maxOutputTokens: positiveInteger,
    reasoningSupported: z.boolean(),
    reasoningEfforts: z.array(z.enum(["low", "medium", "high"])),
  })
  .strict()
  .refine((value) => value.maxOutputTokens <= value.contextWindowTokens, {
    message: "maxOutputTokens 不能超过 contextWindowTokens。",
    path: ["maxOutputTokens"],
  })
  .refine((value) => value.reasoningSupported || value.reasoningEfforts.length === 0, {
    message: "Reasoning is unsupported, so no reasoning efforts may be declared.",
    path: ["reasoningEfforts"],
  });

const providerSchema = z
  .object({
    displayName: z.string().trim().min(1),
    baseUrl: z.url(),
    models: z.record(z.string().min(1), modelCapabilitiesSchema),
  })
  .strict();

const embeddingModelSchema = z
  .object({
    modelId: z.string().trim().min(1),
    modelName: z.string().trim().min(1),
    revision: z.string().trim().min(1),
    modelFile: z.string().trim().min(1),
    maxInputTokens: positiveInteger,
    queryPrefix: z.string(),
  })
  .strict();

export const softwareConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    gpuAcceleration: z.boolean(),
    llm: z
      .object({
        selectedProvider: z.string().min(1).nullable(),
        selectedModel: z.string().min(1).nullable(),
        modelParameters: z
          .object({
            reasoningEnabled: z.boolean(),
            reasoningEffort: z.enum(["low", "medium", "high"]).optional(),
          })
          .strict(),
        providers: z.record(z.string().min(1), providerSchema),
        timeouts: z
          .object({
            connectionMs: positiveInteger,
            streamIdleMs: positiveInteger,
            overallMs: positiveInteger,
          })
          .strict(),
      })
      .strict(),
    context: z
      .object({
        nextUserInputReserveTokens: positiveInteger,
        nextUserInputReserveRatio: positiveRatio,
        safetyMarginRatio: positiveRatio,
        softCompactionRatio: positiveRatio,
        hardCompactionRatio: positiveRatio,
      })
      .strict(),
    agent: z
      .object({
        maxToolRounds: positiveInteger,
        compaction: z
          .object({
            summaryTargetRatio: positiveRatio,
            summaryTargetMinTokens: positiveInteger,
            summaryTargetMaxTokens: positiveInteger,
            segmentSummaryMaxTokens: positiveInteger,
            segmentPayloadTargetRatio: positiveRatio,
            splitSearchWindowRatio: positiveRatio,
            resultMinLimitTokens: positiveInteger,
            resultMaxLimitTokens: positiveInteger,
            resultTargetMultiplier: positiveInteger,
          })
          .strict(),
      })
      .strict(),
    rag: z
      .object({
        retrieval: z
          .object({
            candidateLimit: positiveInteger.max(100),
            rrfK: positiveInteger,
            contextMaxCharacters: positiveInteger,
            maxSourceRatio: positiveRatio,
          })
          .strict(),
        languageDetection: z.object({ minBlockUnits: positiveInteger }).strict(),
        embedding: z
          .object({
            worker: z.object({ chunkBatchSize: positiveInteger }).strict(),
            models: z
              .object({
                zh: embeddingModelSchema,
                en: embeddingModelSchema,
              })
              .strict(),
          })
          .strict(),
        chunking: z
          .object({
            splitSearchWindowRatio: positiveRatio,
          })
          .strict(),
      })
      .strict(),
    materials: z.object({ maxImportBytes: positiveInteger }).strict(),
    database: z.object({ busyTimeoutMs: positiveInteger }).strict(),
    debug: z.object({ enabled: z.boolean() }).strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.context.softCompactionRatio >= value.context.hardCompactionRatio) {
      context.addIssue({
        code: "custom",
        message: "softCompactionRatio 必须小于 hardCompactionRatio。",
        path: ["context", "softCompactionRatio"],
      });
    }
    if (
      value.agent.compaction.summaryTargetMinTokens > value.agent.compaction.summaryTargetMaxTokens
    ) {
      context.addIssue({
        code: "custom",
        message: "摘要目标最小值不能超过最大值。",
        path: ["agent", "compaction", "summaryTargetMinTokens"],
      });
    }
    if (value.agent.compaction.resultMinLimitTokens > value.agent.compaction.resultMaxLimitTokens) {
      context.addIssue({
        code: "custom",
        message: "压缩结果最小限制不能超过最大限制。",
        path: ["agent", "compaction", "resultMinLimitTokens"],
      });
    }
  });

export type SoftwareConfig = z.infer<typeof softwareConfigSchema>;
export type ProviderModelCapabilities = z.infer<typeof modelCapabilitiesSchema>;

export interface SoftwareConfigWarning {
  path: string;
  message: string;
}

export interface SoftwareConfigLoadResult {
  config: SoftwareConfig;
  warnings: SoftwareConfigWarning[];
}
