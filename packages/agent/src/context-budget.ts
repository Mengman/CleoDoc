import type {
  ChatMessage,
  ContextBudgetPolicy,
  ContextBudgetStatus,
  ModelToolDefinition,
} from "../../contracts/src/index.js";

export const DEFAULT_CONTEXT_WINDOW_TOKENS = 32_768;

export function createContextBudgetPolicy(
  contextWindowTokens = DEFAULT_CONTEXT_WINDOW_TOKENS,
): ContextBudgetPolicy {
  const reservedOutputTokens = Math.min(4_096, Math.floor(contextWindowTokens * 0.2));
  return {
    contextWindowTokens,
    reservedOutputTokens,
    nextUserInputReserveTokens: Math.min(2_048, Math.floor(contextWindowTokens * 0.1)),
    safetyMarginRatio: 0.1,
    softCompactionRatio: 0.75,
    hardCompactionRatio: 0.9,
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
