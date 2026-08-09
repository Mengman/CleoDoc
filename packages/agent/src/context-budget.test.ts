import { describe, expect, it } from "vitest";

import { createContextBudgetPolicy } from "./context-budget.js";

const settings = {
  nextUserInputReserveTokens: 32_768,
  nextUserInputReserveRatio: 0.05,
  safetyMarginRatio: 0.05,
  softCompactionRatio: 0.75,
  hardCompactionRatio: 0.9,
};

describe("context budget defaults", () => {
  it("uses the injected model capabilities and context settings", () => {
    expect(
      createContextBudgetPolicy(
        { contextWindowTokens: 1_000_000, maxOutputTokens: 384_000 },
        settings,
      ),
    ).toMatchObject({
      contextWindowTokens: 1_000_000,
      reservedOutputTokens: 384_000,
      nextUserInputReserveTokens: 32_768,
      safetyMarginRatio: 0.05,
      softCompactionRatio: 0.75,
      hardCompactionRatio: 0.9,
    });
  });

  it("derives the reviewed soft and hard thresholds for a one-million-token model", () => {
    const policy = createContextBudgetPolicy(
      { contextWindowTokens: 1_000_000, maxOutputTokens: 384_000 },
      settings,
    );
    const effectiveLimit =
      policy.contextWindowTokens -
      policy.reservedOutputTokens -
      Math.floor(policy.contextWindowTokens * policy.safetyMarginRatio);

    expect(effectiveLimit).toBe(566_000);
    expect(effectiveLimit * policy.softCompactionRatio).toBe(424_500);
    expect(effectiveLimit * policy.hardCompactionRatio).toBe(509_400);
    expect(effectiveLimit * policy.softCompactionRatio - policy.nextUserInputReserveTokens).toBe(
      391_732,
    );
    expect(effectiveLimit * policy.hardCompactionRatio - policy.nextUserInputReserveTokens).toBe(
      476_632,
    );
  });

  it("scales fixed reserves for explicitly configured small context windows", () => {
    expect(
      createContextBudgetPolicy({ contextWindowTokens: 20_000, maxOutputTokens: 7_680 }, settings),
    ).toEqual({
      contextWindowTokens: 20_000,
      reservedOutputTokens: 7_680,
      nextUserInputReserveTokens: 1_000,
      safetyMarginRatio: 0.05,
      softCompactionRatio: 0.75,
      hardCompactionRatio: 0.9,
    });
  });
});
