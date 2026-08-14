export type SessionStatus = "active" | "compacting" | "closed";
export type SessionTrigger = "conversation_started" | "automatic" | "manual";

export interface ConversationSession {
  id: string;
  conversationId: string;
  ordinal: number;
  status: SessionStatus;
  trigger: SessionTrigger;
  systemPromptSnapshot: string;
  inheritedCompactionJobId: string | null;
  estimatedInputTokens: number;
  actualInputTokens: number | null;
  compactionRequired: boolean;
  startedAt: string;
  closedAt: string | null;
}

export interface SessionSummaryRecord {
  id: string;
  sourceSessionId: string;
  summary: string;
  firstMessageId: string;
  lastMessageId: string;
  promptVersion: string;
  createdAt: string;
}

export interface ContextBudgetPolicy {
  contextWindowTokens: number;
  reservedOutputTokens: number;
  nextUserInputReserveTokens: number;
  safetyMarginRatio: number;
  softCompactionRatio: number;
  hardCompactionRatio: number;
}

export interface ContextBudgetStatus {
  estimatedInputTokens: number;
  effectiveLimitTokens: number;
  ratio: number;
  softLimitReached: boolean;
  hardLimitReached: boolean;
  policy: ContextBudgetPolicy;
}

export type CompactionEvent =
  | {
      type: "compaction-started";
      conversationId: string;
      sessionId: string;
      reason: "soft-threshold" | "hard-threshold" | "manual";
      estimatedRatio: number;
    }
  | { type: "compaction-validating"; jobId: string }
  | {
      type: "compaction-completed";
      jobId: string;
      closedSessionId: string;
      newSessionId: string;
      archivedMessageCount: number;
      summaryTokens: number;
    }
  | {
      type: "compaction-failed";
      jobId: string;
      recoverable: boolean;
      errorCode: string;
    };
