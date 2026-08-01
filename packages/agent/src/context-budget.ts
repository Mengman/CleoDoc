import type {
  ChatMessage,
  ContextBudgetPolicy,
  ContextBudgetStatus,
  ModelToolDefinition,
} from "../../contracts/src/index.js";

export const DEFAULT_CONTEXT_WINDOW_TOKENS = 1_000_000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 384_000;
export const DEFAULT_NEXT_USER_INPUT_RESERVE_TOKENS = 32_768;
export const DEFAULT_SAFETY_MARGIN_RATIO = 0.05;
export const DEFAULT_SOFT_COMPACTION_RATIO = 0.75;
export const DEFAULT_HARD_COMPACTION_RATIO = 0.9;

export function createContextBudgetPolicy(
  contextWindowTokens = DEFAULT_CONTEXT_WINDOW_TOKENS,
): ContextBudgetPolicy {
  const reservedOutputTokens = Math.min(
    DEFAULT_MAX_OUTPUT_TOKENS,
    Math.floor(contextWindowTokens * 0.384),
  );
  return {
    contextWindowTokens,
    reservedOutputTokens,
    nextUserInputReserveTokens: Math.min(
      DEFAULT_NEXT_USER_INPUT_RESERVE_TOKENS,
      Math.floor(contextWindowTokens * 0.05),
    ),
    safetyMarginRatio: DEFAULT_SAFETY_MARGIN_RATIO,
    softCompactionRatio: DEFAULT_SOFT_COMPACTION_RATIO,
    hardCompactionRatio: DEFAULT_HARD_COMPACTION_RATIO,
  };
}

export class ContextBudgetService {
  estimate(
    messages: readonly ChatMessage[],
    tools: readonly ModelToolDefinition[],
    policy: ContextBudgetPolicy,
    additionalText = "",
  ): ContextBudgetStatus {
    const payload = JSON.stringify({ messages, tools }) + additionalText;
    const estimatedInputTokens = estimateTokens(payload) + policy.nextUserInputReserveTokens;
    const effectiveLimitTokens = Math.max(
      1,
      policy.contextWindowTokens -
        policy.reservedOutputTokens -
        Math.floor(policy.contextWindowTokens * policy.safetyMarginRatio),
    );
    const ratio = estimatedInputTokens / effectiveLimitTokens;
    return {
      estimatedInputTokens,
      effectiveLimitTokens,
      ratio,
      softLimitReached: ratio >= policy.softCompactionRatio,
      hardLimitReached: ratio >= policy.hardCompactionRatio,
      policy,
    };
  }
}

export function estimateTokens(text: string): number {
  let ascii = 0;
  let nonAscii = 0;
  for (const character of text) {
    if (character.codePointAt(0)! <= 0x7f) ascii += 1;
    else nonAscii += 1;
  }
  return Math.ceil(ascii / 3.5 + nonAscii * 1.15 + 16);
}
