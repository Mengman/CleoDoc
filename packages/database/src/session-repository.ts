import { randomUUID } from "node:crypto";

import type {
  ConversationSession,
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
  inherited_compaction_job_id: string | null;
  estimated_input_tokens: number;
  actual_input_tokens: number | null;
  compaction_required: number;
  started_at: string;
  closed_at: string | null;
}

interface SummaryRow {
  id: string;
  source_session_id: string;
  summary: string;
  first_message_id: string;
  last_message_id: string;
  prompt_version: string;
  created_at: string;
}

interface CompactionJobCompletionRow {
  source_session_id: string;
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

  getSummary(id: string): SessionSummaryRecord | null {
    const row = this.projectDatabase.read(
      (database) =>
        database
          .prepare("SELECT * FROM compaction_jobs WHERE id = ? AND status = 'completed'")
          .get(id) as SummaryRow | undefined,
    );
    return row === undefined ? null : mapSummary(row);
  }

  getInheritedSummary(session: ConversationSession): SessionSummaryRecord | null {
    if (session.inheritedCompactionJobId === null) return null;
    const summary = this.getSummary(session.inheritedCompactionJobId);
    const source = summary === null ? null : this.getSession(summary.sourceSessionId);
    if (summary === null || source?.conversationId !== session.conversationId) {
      throw new AppError("DATABASE_ERROR", "当前 Session 继承的摘要不存在或归属不匹配。", {
        details: {
          sessionId: session.id,
          inheritedCompactionJobId: session.inheritedCompactionJobId,
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
            "SELECT * FROM compaction_jobs WHERE source_session_id = ? AND status = 'completed' LIMIT 1",
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
    promptVersion: string;
    messages: readonly StoredMessage[];
    orchestrationConfig: Readonly<Record<string, unknown>>;
  }): Promise<string> {
    // Freeze a Session message boundary and start its compaction Job atomically.
    // 1. Reject an empty Session before changing persistent state.
    // 2. Move the source Session from active to compacting.
    // 3. Insert the running Job with prompt and orchestration snapshots.
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
           (id, source_session_id, status, trigger, prompt_version, first_message_id,
            last_message_id, orchestration_config_json, created_at)
           VALUES (?, ?, 'running', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.session.id,
          input.trigger,
          input.promptVersion,
          input.messages[0]!.id,
          input.messages.at(-1)!.id,
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
    trigger: SessionTrigger;
    estimatedInputTokens: number;
  }): Promise<{ newSessionId: string }> {
    // Adopt a validated summary and activate the next Session atomically.
    // 1. Verify the Job still belongs to the expected source Session.
    // 2. Close the source Session and create its successor linked to the Job.
    // 3. Mark the Job completed and store the accepted summary on it.
    const newSessionId = randomUUID();
    const now = new Date().toISOString();
    await this.projectDatabase.transaction((database) => {
      const job = database
        .prepare(`SELECT source_session_id FROM compaction_jobs WHERE id = ?`)
        .get(input.jobId) as CompactionJobCompletionRow | undefined;
      if (job === undefined || job.source_session_id !== input.sourceSession.id) {
        throw new AppError("VALIDATION_ERROR", "压缩任务与来源 Session 不匹配。");
      }

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
            inherited_compaction_job_id, started_at)
           VALUES (?, ?, ?, 'active', ?, ?, ?, ?)`,
        )
        .run(
          newSessionId,
          input.sourceSession.conversationId,
          input.sourceSession.ordinal + 1,
          input.trigger,
          input.sourceSession.systemPromptSnapshot,
          input.jobId,
          now,
        );
      database
        .prepare(
          `UPDATE compaction_jobs SET status = 'completed', summary = ?, completed_at = ?
           WHERE id = ?`,
        )
        .run(input.summary, now, input.jobId);
    });
    return { newSessionId };
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
    inheritedCompactionJobId: row.inherited_compaction_job_id,
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
    sourceSessionId: row.source_session_id,
    summary: row.summary,
    firstMessageId: row.first_message_id,
    lastMessageId: row.last_message_id,
    promptVersion: row.prompt_version,
    createdAt: row.created_at,
  };
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
