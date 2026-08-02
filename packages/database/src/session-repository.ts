import { randomUUID } from "node:crypto";

import type {
  ConversationSession,
  ModelUsage,
  SessionSummaryRecord,
  SessionTrigger,
  StoredMessage,
} from "../../contracts/src/index.js";
import { AppError } from "../../contracts/src/index.js";
import type { ProjectDatabase } from "./project-database.js";

interface SessionRow {
  id: string;
  conversation_id: string;
  ordinal: number;
  status: ConversationSession["status"];
  trigger: SessionTrigger;
  system_prompt_snapshot: string;
  inherited_summary_id: string | null;
  estimated_input_tokens: number;
  actual_input_tokens: number | null;
  compaction_required: number;
  started_at: string;
  closed_at: string | null;
}

interface SummaryRow {
  id: string;
  conversation_id: string;
  source_session_id: string;
  summary: string;
  first_message_id: string;
  last_message_id: string;
  message_count: number;
  prompt_version: string;
  provider_id: string;
  model: string;
  usage_json: string | null;
  created_at: string;
}

interface CompactionJobCompletionRow {
  conversation_id: string;
  source_session_id: string;
  prompt_version: string;
  provider_id: string;
  model: string;
  first_message_id: string;
  last_message_id: string;
  message_count: number;
}

interface HistoryRow {
  message_rowid: number;
  id: string;
  conversation_id: string;
  session_id: string;
  sequence: number;
  role: StoredMessage["role"];
  content: string;
  reasoning_content: string | null;
  name: string | null;
  tool_call_id: string | null;
  tool_calls_json: string | null;
  model_call_id: string | null;
  created_at: string;
}

export interface HistorySearchResult {
  messageId: string;
  role: "user" | "assistant";
  createdAt: string;
  excerpt: string;
}

export class SessionRepository {
  constructor(private readonly projectDatabase: ProjectDatabase) {}

  async createInitialSession(input: {
    conversationId: string;
    systemPrompt: string;
  }): Promise<ConversationSession> {
    const current = this.getCurrentSession(input.conversationId);
    if (current !== null) return current;

    const id = randomUUID();
    const now = new Date().toISOString();
    await this.projectDatabase.write((database) => {
      database
        .prepare(
          `INSERT INTO conversation_sessions
           (id, conversation_id, ordinal, status, trigger, system_prompt_snapshot, started_at)
           VALUES (?, ?, 1, 'active', 'conversation_started', ?, ?)`,
        )
        .run(id, input.conversationId, input.systemPrompt, now);
    });
    return this.getSession(id)!;
  }

  getSession(id: string): ConversationSession | null {
    const row = this.projectDatabase.read(
      (database) =>
        database.prepare("SELECT * FROM conversation_sessions WHERE id = ?").get(id) as
          SessionRow | undefined,
    );
    return row === undefined ? null : mapSession(row);
  }

  getCurrentSession(conversationId: string): ConversationSession | null {
    const row = this.projectDatabase.read(
      (database) =>
        database
          .prepare(
            `SELECT * FROM conversation_sessions
             WHERE conversation_id = ? AND status IN ('active', 'compacting')
             ORDER BY ordinal DESC LIMIT 1`,
          )
          .get(conversationId) as SessionRow | undefined,
    );
    return row === undefined ? null : mapSession(row);
  }

  listSessions(conversationId: string): ConversationSession[] {
    return this.projectDatabase
      .read(
        (database) =>
          database
            .prepare(
              "SELECT * FROM conversation_sessions WHERE conversation_id = ? ORDER BY ordinal",
            )
            .all(conversationId) as unknown as SessionRow[],
      )
      .map(mapSession);
  }

  getSessionMessages(sessionId: string): StoredMessage[] {
    const rows = this.projectDatabase.read(
      (database) =>
        database
          .prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY sequence")
          .all(sessionId) as unknown as HistoryRow[],
    );
    return rows.map(mapHistoryMessage);
  }

  getLatestSummary(conversationId: string): SessionSummaryRecord | null {
    const row = this.projectDatabase.read(
      (database) =>
        database
          .prepare(
            "SELECT * FROM session_summaries WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
          )
          .get(conversationId) as SummaryRow | undefined,
    );
    return row === undefined ? null : mapSummary(row);
  }

  getSummary(id: string): SessionSummaryRecord | null {
    const row = this.projectDatabase.read(
      (database) =>
        database.prepare("SELECT * FROM session_summaries WHERE id = ?").get(id) as
          SummaryRow | undefined,
    );
    return row === undefined ? null : mapSummary(row);
  }

  getInheritedSummary(session: ConversationSession): SessionSummaryRecord | null {
    if (session.inheritedSummaryId === null) return null;
    const summary = this.getSummary(session.inheritedSummaryId);
    if (summary === null || summary.conversationId !== session.conversationId) {
      throw new AppError("DATABASE_ERROR", "当前 Session 继承的摘要不存在或归属不匹配。", {
        details: {
          sessionId: session.id,
          inheritedSummaryId: session.inheritedSummaryId,
        },
      });
    }
    return summary;
  }

  getSummaryForSourceSession(sessionId: string): SessionSummaryRecord | null {
    const row = this.projectDatabase.read(
      (database) =>
        database
          .prepare(
            "SELECT * FROM session_summaries WHERE source_session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
          )
          .get(sessionId) as SummaryRow | undefined,
    );
    return row === undefined ? null : mapSummary(row);
  }

  async updateBudget(
    sessionId: string,
    estimatedInputTokens: number,
    actualInputTokens: number | null,
    compactionRequired: boolean,
  ): Promise<void> {
    await this.projectDatabase.write((database) => {
      database
        .prepare(
          `UPDATE conversation_sessions SET estimated_input_tokens = ?, actual_input_tokens = ?,
           compaction_required = ? WHERE id = ?`,
        )
        .run(estimatedInputTokens, actualInputTokens, compactionRequired ? 1 : 0, sessionId);
    });
  }

  async beginCompaction(input: {
    session: ConversationSession;
    trigger: SessionTrigger;
    providerId: string;
    model: string;
    promptVersion: string;
    messages: readonly StoredMessage[];
    previousSummaryId: string | null;
    orchestrationConfig: Readonly<Record<string, unknown>>;
  }): Promise<string> {
    if (input.messages.length === 0) {
      throw new AppError("VALIDATION_ERROR", "当前 Session 没有可压缩的消息。");
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.projectDatabase.transaction((database) => {
      const changed = database
        .prepare(
          "UPDATE conversation_sessions SET status = 'compacting' WHERE id = ? AND status = 'active'",
        )
        .run(input.session.id);
      if (Number(changed.changes) !== 1) {
        throw new AppError("VALIDATION_ERROR", "当前 Session 不可压缩或已有压缩任务。");
      }
      database
        .prepare(
          `INSERT INTO compaction_jobs
           (id, conversation_id, source_session_id, previous_summary_id, status, trigger,
            provider_id, model, prompt_version, first_message_id, last_message_id,
            message_count, attempt_count, orchestration_config_json, created_at)
           VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        )
        .run(
          id,
          input.session.conversationId,
          input.session.id,
          input.previousSummaryId,
          input.trigger,
          input.providerId,
          input.model,
          input.promptVersion,
          input.messages[0]!.id,
          input.messages.at(-1)!.id,
          input.messages.length,
          JSON.stringify(input.orchestrationConfig),
          now,
        );
    });
    return id;
  }

  async markCompactionValidating(jobId: string): Promise<void> {
    await this.projectDatabase.write((database) => {
      database.prepare("UPDATE compaction_jobs SET status = 'validating' WHERE id = ?").run(jobId);
    });
  }

  async recordCompactionAttempt(jobId: string): Promise<void> {
    await this.projectDatabase.write((database) => {
      database
        .prepare(
          "UPDATE compaction_jobs SET status = 'running', attempt_count = attempt_count + 1 WHERE id = ?",
        )
        .run(jobId);
    });
  }

  async failCompaction(jobId: string, errorCode: string, cancelled = false): Promise<void> {
    const now = new Date().toISOString();
    await this.projectDatabase.transaction((database) => {
      const job = database
        .prepare("SELECT source_session_id FROM compaction_jobs WHERE id = ?")
        .get(jobId) as { source_session_id: string } | undefined;
      if (job === undefined) return;
      database
        .prepare(
          "UPDATE compaction_jobs SET status = ?, error_code = ?, completed_at = ? WHERE id = ?",
        )
        .run(cancelled ? "cancelled" : "failed", errorCode, now, jobId);
      database
        .prepare(
          "UPDATE conversation_sessions SET status = 'active', compaction_required = 1 WHERE id = ? AND status = 'compacting'",
        )
        .run(job.source_session_id);
    });
  }

  async completeCompaction(input: {
    jobId: string;
    sourceSession: ConversationSession;
    summary: string;
    usage?: ModelUsage;
    trigger: SessionTrigger;
    estimatedInputTokens: number;
  }): Promise<{ summaryId: string; newSessionId: string }> {
    const summaryId = randomUUID();
    const newSessionId = randomUUID();
    const now = new Date().toISOString();
    await this.projectDatabase.transaction((database) => {
      const job = database
        .prepare(
          `SELECT conversation_id, source_session_id, prompt_version, provider_id, model,
                  first_message_id, last_message_id, message_count
           FROM compaction_jobs WHERE id = ?`,
        )
        .get(input.jobId) as CompactionJobCompletionRow | undefined;
      if (
        job === undefined ||
        job.conversation_id !== input.sourceSession.conversationId ||
        job.source_session_id !== input.sourceSession.id
      ) {
        throw new AppError("VALIDATION_ERROR", "压缩任务与来源 Session 不匹配。");
      }

      database
        .prepare(
          `INSERT INTO session_summaries
           (id, conversation_id, source_session_id, summary, first_message_id, last_message_id,
            message_count, prompt_version, provider_id, model, usage_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          summaryId,
          job.conversation_id,
          job.source_session_id,
          input.summary,
          job.first_message_id,
          job.last_message_id,
          Number(job.message_count),
          job.prompt_version,
          job.provider_id,
          job.model,
          input.usage === undefined ? null : JSON.stringify(input.usage),
          now,
        );
      database
        .prepare(
          `UPDATE conversation_sessions SET status = 'closed', closed_at = ?,
           compaction_required = 0, estimated_input_tokens = ? WHERE id = ? AND status = 'compacting'`,
        )
        .run(now, input.estimatedInputTokens, input.sourceSession.id);
      database
        .prepare(
          `INSERT INTO conversation_sessions
           (id, conversation_id, ordinal, status, trigger, system_prompt_snapshot,
            inherited_summary_id, started_at)
           VALUES (?, ?, ?, 'active', ?, ?, ?, ?)`,
        )
        .run(
          newSessionId,
          input.sourceSession.conversationId,
          input.sourceSession.ordinal + 1,
          input.trigger,
          input.sourceSession.systemPromptSnapshot,
          summaryId,
          now,
        );
      database
        .prepare(
          `UPDATE compaction_jobs SET status = 'completed', summary_id = ?, usage_json = ?,
           completed_at = ? WHERE id = ?`,
        )
        .run(
          summaryId,
          input.usage === undefined ? null : JSON.stringify(input.usage),
          now,
          input.jobId,
        );
    });
    return { summaryId, newSessionId };
  }

  async recoverInterruptedJobs(): Promise<void> {
    const now = new Date().toISOString();
    await this.projectDatabase.transaction((database) => {
      database
        .prepare(
          `UPDATE compaction_jobs SET status = 'failed', error_code = 'COMPACTION_INTERRUPTED',
           completed_at = ? WHERE status IN ('pending', 'running', 'validating')`,
        )
        .run(now);
      database
        .prepare(
          `UPDATE conversation_sessions SET status = 'active', compaction_required = 1
           WHERE status = 'compacting'`,
        )
        .run();
    });
  }

  searchClosedHistory(input: {
    conversationId: string;
    query: string;
    limit: number;
  }): HistorySearchResult[] {
    const terms = input.query.trim();
    if (terms === "") return [];
    const match = `"${terms.replaceAll('"', '""')}"`;
    const rows = this.projectDatabase.read(
      (database) =>
        database
          .prepare(
            `SELECT m.id AS message_id, m.role, m.created_at,
                    snippet(conversation_message_fts, 0, '[', ']', '…', 24) AS excerpt,
                    bm25(conversation_message_fts) AS rank
             FROM conversation_message_fts f
             JOIN messages m ON m.message_rowid = f.rowid
             JOIN conversation_sessions s ON s.id = m.session_id
             WHERE conversation_message_fts MATCH ? AND m.conversation_id = ?
               AND s.status = 'closed' AND m.role IN ('user', 'assistant')
             ORDER BY rank LIMIT ?`,
          )
          .all(match, input.conversationId, input.limit) as unknown as Array<{
          message_id: string;
          role: "user" | "assistant";
          created_at: string;
          excerpt: string;
        }>,
    );
    return rows.map((row) => ({
      messageId: row.message_id,
      role: row.role,
      createdAt: row.created_at,
      excerpt: row.excerpt,
    }));
  }

  readClosedMessage(input: { conversationId: string; messageId: string }): StoredMessage {
    const row = this.projectDatabase.read(
      (database) =>
        database
          .prepare(
            `SELECT m.* FROM messages m
             JOIN conversation_sessions s ON s.id = m.session_id
             WHERE m.id = ? AND m.conversation_id = ? AND s.status = 'closed'
               AND m.role IN ('user', 'assistant')`,
          )
          .get(input.messageId, input.conversationId) as HistoryRow | undefined,
    );
    if (row === undefined) {
      throw new AppError(
        "HISTORY_MESSAGE_NOT_FOUND",
        "找不到指定的已关闭历史消息，请重新搜索会话历史。",
      );
    }
    return mapHistoryMessage(row);
  }
}

function mapSession(row: SessionRow): ConversationSession {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    ordinal: Number(row.ordinal),
    status: row.status,
    trigger: row.trigger,
    systemPromptSnapshot: row.system_prompt_snapshot,
    inheritedSummaryId: row.inherited_summary_id,
    estimatedInputTokens: Number(row.estimated_input_tokens),
    actualInputTokens: row.actual_input_tokens === null ? null : Number(row.actual_input_tokens),
    compactionRequired: row.compaction_required === 1,
    startedAt: row.started_at,
    closedAt: row.closed_at,
  };
}

function mapSummary(row: SummaryRow): SessionSummaryRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    sourceSessionId: row.source_session_id,
    summary: row.summary,
    firstMessageId: row.first_message_id,
    lastMessageId: row.last_message_id,
    messageCount: Number(row.message_count),
    promptVersion: row.prompt_version,
    providerId: row.provider_id,
    model: row.model,
    usage: parseModelUsage(row.usage_json),
    createdAt: row.created_at,
  };
}

function parseModelUsage(value: string | null): ModelUsage | null {
  if (value === null) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const keys = ["inputTokens", "outputTokens", "reasoningTokens", "totalTokens"] as const;
    const usage: ModelUsage = {};
    for (const key of keys) {
      const count = record[key];
      if (count === undefined) continue;
      if (typeof count !== "number" || !Number.isFinite(count) || count < 0) return null;
      usage[key] = count;
    }
    return usage;
  } catch {
    return null;
  }
}

function mapHistoryMessage(row: HistoryRow): StoredMessage {
  return {
    messageRowid: Number(row.message_rowid),
    id: row.id,
    conversationId: row.conversation_id,
    sessionId: row.session_id,
    modelCallId: row.model_call_id,
    sequence: Number(row.sequence),
    role: row.role,
    content: row.content,
    ...(row.reasoning_content === null ? {} : { reasoningContent: row.reasoning_content }),
    ...(row.name === null ? {} : { name: row.name }),
    ...(row.tool_call_id === null ? {} : { toolCallId: row.tool_call_id }),
    ...(row.tool_calls_json === null
      ? {}
      : { toolCalls: JSON.parse(row.tool_calls_json) as StoredMessage["toolCalls"] }),
    createdAt: row.created_at,
  };
}
