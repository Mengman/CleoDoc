import { randomUUID } from "node:crypto";

import type {
  ConversationSession,
  ModelUsage,
  SessionCompactionResult,
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
  project_instructions_path: string | null;
  project_instructions_snapshot: string | null;
  project_instructions_hash: string | null;
  project_instructions_loaded_at: string;
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
  content_json: string;
  handoff_text: string;
  prompt_version: string;
  provider_id: string;
  model: string;
  usage_json: string | null;
  created_at: string;
}

interface HistoryRow {
  id: string;
  conversation_id: string;
  session_id: string | null;
  sequence: number;
  role: StoredMessage["role"];
  content: string;
  name: string | null;
  tool_call_id: string | null;
  tool_calls_json: string | null;
  created_at: string;
}

export interface ProjectInstructionSnapshot {
  path: string | null;
  content: string | null;
  hash: string | null;
  loadedAt: string;
}

export interface HistorySearchResult {
  sessionId: string;
  messageId: string;
  sequence: number;
  role: "user" | "assistant";
  createdAt: string;
  excerpt: string;
  rank: number;
}

export class SessionRepository {
  constructor(private readonly projectDatabase: ProjectDatabase) {}

  async createInitialSession(input: {
    conversationId: string;
    systemPrompt: string;
    instructions: ProjectInstructionSnapshot;
  }): Promise<ConversationSession> {
    const current = this.getCurrentSession(input.conversationId);
    if (current !== null) {
      if (current.systemPromptSnapshot === "") {
        await this.projectDatabase.write((database) => {
          database
            .prepare(
              `UPDATE conversation_sessions SET system_prompt_snapshot = ?,
               project_instructions_path = ?, project_instructions_snapshot = ?,
               project_instructions_hash = ?, project_instructions_loaded_at = ? WHERE id = ?`,
            )
            .run(
              input.systemPrompt,
              input.instructions.path,
              input.instructions.content,
              input.instructions.hash,
              input.instructions.loadedAt,
              current.id,
            );
        });
        return this.getSession(current.id)!;
      }
      return current;
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    await this.projectDatabase.write((database) => {
      database
        .prepare(
          `INSERT INTO conversation_sessions
           (id, conversation_id, ordinal, status, trigger, system_prompt_snapshot,
            project_instructions_path, project_instructions_snapshot, project_instructions_hash,
            project_instructions_loaded_at, started_at)
           VALUES (?, ?, 1, 'active', 'conversation_started', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.conversationId,
          input.systemPrompt,
          input.instructions.path,
          input.instructions.content,
          input.instructions.hash,
          input.instructions.loadedAt,
          now,
        );
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
            message_count, attempt_count, parameters_json, created_at)
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
          JSON.stringify({ temperature: 0.1 }),
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
    result: SessionCompactionResult;
    handoffText: string;
    promptVersion: string;
    providerId: string;
    model: string;
    usage?: ModelUsage;
    trigger: SessionTrigger;
    instructions: ProjectInstructionSnapshot;
    estimatedInputTokens: number;
  }): Promise<{ summaryId: string; newSessionId: string }> {
    const summaryId = randomUUID();
    const newSessionId = randomUUID();
    const now = new Date().toISOString();
    await this.projectDatabase.transaction((database) => {
      database
        .prepare(
          `INSERT INTO session_summaries
           (id, conversation_id, source_session_id, content_json, handoff_text, prompt_version,
            provider_id, model, usage_json, parameters_json, validation_status,
            first_message_id, last_message_id, message_count, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'validated', ?, ?, ?, ?)`,
        )
        .run(
          summaryId,
          input.sourceSession.conversationId,
          input.sourceSession.id,
          JSON.stringify(input.result),
          input.handoffText,
          input.promptVersion,
          input.providerId,
          input.model,
          input.usage === undefined ? null : JSON.stringify(input.usage),
          JSON.stringify({ temperature: 0.1 }),
          input.result.coveredMessages.firstMessageId,
          input.result.coveredMessages.lastMessageId,
          input.result.coveredMessages.count,
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
            project_instructions_path, project_instructions_snapshot, project_instructions_hash,
            project_instructions_loaded_at, inherited_summary_id, started_at)
           VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          newSessionId,
          input.sourceSession.conversationId,
          input.sourceSession.ordinal + 1,
          input.trigger,
          input.sourceSession.systemPromptSnapshot,
          input.instructions.path,
          input.instructions.content,
          input.instructions.hash,
          input.instructions.loadedAt,
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
    sessionIds?: readonly string[];
    roles?: readonly ("user" | "assistant")[];
    limit: number;
  }): HistorySearchResult[] {
    const terms = input.query.trim();
    if (terms === "") return [];
    const sessionFilter = input.sessionIds?.length
      ? ` AND f.session_id IN (${input.sessionIds.map(() => "?").join(",")})`
      : "";
    const roles = input.roles?.length ? input.roles : (["user", "assistant"] as const);
    const roleFilter = ` AND f.role IN (${roles.map(() => "?").join(",")})`;
    const match = `"${terms.replaceAll('"', '""')}"`;
    const rows = this.projectDatabase.read(
      (database) =>
        database
          .prepare(
            `SELECT f.message_id, f.session_id, f.role, m.sequence, m.created_at,
                    snippet(conversation_message_fts, 4, '[', ']', '…', 24) AS excerpt,
                    bm25(conversation_message_fts) AS rank
             FROM conversation_message_fts f
             JOIN conversation_sessions s ON s.id = f.session_id
             JOIN messages m ON m.id = f.message_id
             WHERE conversation_message_fts MATCH ? AND f.conversation_id = ?
               AND s.status = 'closed'${sessionFilter}${roleFilter}
             ORDER BY rank LIMIT ?`,
          )
          .all(
            match,
            input.conversationId,
            ...(input.sessionIds ?? []),
            ...roles,
            input.limit,
          ) as unknown as Array<{
          message_id: string;
          session_id: string;
          role: "user" | "assistant";
          sequence: number;
          created_at: string;
          excerpt: string;
          rank: number;
        }>,
    );
    return rows.map((row) => ({
      sessionId: row.session_id,
      messageId: row.message_id,
      sequence: Number(row.sequence),
      role: row.role,
      createdAt: row.created_at,
      excerpt: row.excerpt,
      rank: Number(row.rank),
    }));
  }

  readClosedHistory(input: {
    conversationId: string;
    sessionId: string;
    afterMessageId?: string;
    limitMessages: number;
  }): StoredMessage[] {
    const session = this.getSession(input.sessionId);
    if (
      session === null ||
      session.conversationId !== input.conversationId ||
      session.status !== "closed"
    ) {
      throw new AppError("VALIDATION_ERROR", "只能读取当前对话中已关闭的 Session。");
    }
    let afterSequence = -1;
    if (input.afterMessageId !== undefined) {
      const cursor = this.projectDatabase.read(
        (database) =>
          database
            .prepare("SELECT sequence FROM messages WHERE id = ? AND session_id = ?")
            .get(input.afterMessageId!, input.sessionId) as { sequence: number } | undefined,
      );
      if (cursor === undefined) throw new AppError("VALIDATION_ERROR", "历史消息游标无效。");
      afterSequence = Number(cursor.sequence);
    }
    const rows = this.projectDatabase.read(
      (database) =>
        database
          .prepare(
            `SELECT * FROM messages WHERE session_id = ? AND sequence > ?
             AND role IN ('user', 'assistant') ORDER BY sequence LIMIT ?`,
          )
          .all(input.sessionId, afterSequence, input.limitMessages) as unknown as HistoryRow[],
    );
    return rows.map(mapHistoryMessage);
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
    projectInstructionsPath: row.project_instructions_path,
    projectInstructionsSnapshot: row.project_instructions_snapshot,
    projectInstructionsHash: row.project_instructions_hash,
    projectInstructionsLoadedAt: row.project_instructions_loaded_at,
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
    content: JSON.parse(row.content_json) as SessionCompactionResult,
    handoffText: row.handoff_text,
    promptVersion: row.prompt_version,
    providerId: row.provider_id,
    model: row.model,
    usageJson: row.usage_json,
    createdAt: row.created_at,
  };
}

function mapHistoryMessage(row: HistoryRow): StoredMessage {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    sessionId: row.session_id,
    sequence: Number(row.sequence),
    role: row.role,
    content: row.content,
    ...(row.name === null ? {} : { name: row.name }),
    ...(row.tool_call_id === null ? {} : { toolCallId: row.tool_call_id }),
    ...(row.tool_calls_json === null
      ? {}
      : { toolCalls: JSON.parse(row.tool_calls_json) as StoredMessage["toolCalls"] }),
    createdAt: row.created_at,
  };
}
