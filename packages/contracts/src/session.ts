import { z } from "zod";

const sourceIds = z.array(z.string().min(1)).min(1).max(50);
const summaryItemSchema = z.object({
  text: z.string().max(4_000),
  sourceMessageIds: sourceIds,
});

export const sessionCompactionResultSchema = z.object({
  schemaVersion: z.literal(1),
  sourceSessionId: z.string().min(1),
  coveredMessages: z.object({
    firstMessageId: z.string().min(1),
    lastMessageId: z.string().min(1),
    count: z.number().int().nonnegative(),
  }),
  conversationObjective: z.string().max(8_000),
  userDecisions: z.array(summaryItemSchema).max(100),
  acceptedResults: z.array(summaryItemSchema).max(100),
  rejectedDirections: z.array(summaryItemSchema).max(100),
  aiSuggestions: z.array(summaryItemSchema).max(100),
  constraints: z.array(summaryItemSchema).max(100),
  unresolvedQuestions: z.array(summaryItemSchema).max(100),
  pendingTasks: z.array(summaryItemSchema).max(100),
  projectChanges: z
    .array(
      z.object({
        path: z.string().max(1_024),
        action: z.enum(["created", "updated", "deleted"]),
        contentHash: z.string().max(256).optional(),
        description: z.string().max(4_000),
        sourceMessageIds: sourceIds,
      }),
    )
    .max(100),
  relevantDocuments: z
    .array(
      z.object({
        path: z.string().max(1_024),
        description: z.string().max(4_000),
        sourceMessageIds: sourceIds,
      }),
    )
    .max(100),
  knownConflicts: z
    .array(
      z.object({
        description: z.string().max(4_000),
        sourceMessageIds: sourceIds,
      }),
    )
    .max(100),
  detailLookupHints: z
    .array(
      z.object({
        topic: z.string().max(1_000),
        suggestedQuery: z.string().max(1_000),
        sourceMessageIds: sourceIds,
      }),
    )
    .max(100),
  handoffBrief: z.string().max(12_000),
});

export const sessionCompactionOutputJsonSchema = z.toJSONSchema(sessionCompactionResultSchema);

export type SessionCompactionResult = z.infer<typeof sessionCompactionResultSchema>;

export type SessionStatus = "active" | "compacting" | "closed";
export type SessionTrigger = "conversation_started" | "automatic" | "manual";

export interface ConversationSession {
  id: string;
  conversationId: string;
  ordinal: number;
  status: SessionStatus;
  trigger: SessionTrigger;
  systemPromptSnapshot: string;
  projectInstructionsPath: string | null;
  projectInstructionsSnapshot: string | null;
  projectInstructionsHash: string | null;
  projectInstructionsLoadedAt: string;
  inheritedSummaryId: string | null;
  estimatedInputTokens: number;
  actualInputTokens: number | null;
  compactionRequired: boolean;
  startedAt: string;
  closedAt: string | null;
}

export interface SessionSummaryRecord {
  id: string;
  conversationId: string;
  sourceSessionId: string;
  content: SessionCompactionResult;
  handoffText: string;
  promptVersion: string;
  providerId: string;
  model: string;
  usageJson: string | null;
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
