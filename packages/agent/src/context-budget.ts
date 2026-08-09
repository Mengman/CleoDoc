import type {
  ChatMessage,
  ContextBudgetPolicy,
  ContextBudgetStatus,
  ModelToolDefinition,
} from "../../contracts/src/index.js";

export interface ModelContextCapabilities {
  contextWindowTokens: number;
  maxOutputTokens: number;
}

export interface ContextBudgetSettings {
  nextUserInputReserveTokens: number;
  nextUserInputReserveRatio: number;
  safetyMarginRatio: number;
  softCompactionRatio: number;
  hardCompactionRatio: number;
}

export function createContextBudgetPolicy(
  capabilities: ModelContextCapabilities,
  settings: ContextBudgetSettings,
): ContextBudgetPolicy {
  const { contextWindowTokens, maxOutputTokens: reservedOutputTokens } = capabilities;
  return {
    contextWindowTokens,
    reservedOutputTokens,
    nextUserInputReserveTokens: Math.min(
      settings.nextUserInputReserveTokens,
      Math.floor(contextWindowTokens * settings.nextUserInputReserveRatio),
    ),
    safetyMarginRatio: settings.safetyMarginRatio,
    softCompactionRatio: settings.softCompactionRatio,
    hardCompactionRatio: settings.hardCompactionRatio,
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
