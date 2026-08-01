import type { ModelProtocolEvent } from "../../contracts/src/index.js";

export type LlmDebugOperation = "agent" | "compaction" | "compaction-repair";

export type LlmDebugEvent =
  | {
      type: "llm-protocol";
      operation: LlmDebugOperation;
      round: number;
      providerId: string;
      model: string;
      protocol: ModelProtocolEvent;
    }
  | {
      type: "llm-response";
      operation: LlmDebugOperation;
      round: number;
      providerId: string;
      model: string;
      contextTokens: number;
      contextSource: "provider" | "estimated";
      estimatedContextTokens: number;
      outputTokens: number | null;
      reasoningTokens: number | null;
      totalTokens: number | null;
      finishReason: string | null;
    }
  | {
      type: "llm-response-error";
      operation: LlmDebugOperation;
      round: number;
      providerId: string;
      model: string;
      errorCode: string;
      message: string;
      details: Readonly<Record<string, unknown>> | null;
    };

export type LlmDebugHandler = (event: LlmDebugEvent) => void;

export function emitLlmDebugEvent(
  handler: LlmDebugHandler | undefined,
  event: LlmDebugEvent,
): void {
  try {
    handler?.(event);
  } catch {
    // Debug presentation must never change Agent execution.
  }
}
