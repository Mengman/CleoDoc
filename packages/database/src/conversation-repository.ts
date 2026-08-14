import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type {
  ChatMessage,
  ConversationRecord,
  ConversationSummary,
  StoredMessage,
} from "../../contracts/src/index.js";
import { AppError } from "../../contracts/src/index.js";
import type { ProjectDatabase } from "./project-database.js";

interface ConversationRow {
  id: string;
  project_id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
}

interface ConversationSummaryRow extends ConversationRow {
  message_count: number;
}

interface MessageRow {
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

export class ConversationRepository {
  constructor(private readonly projectDatabase: ProjectDatabase) {}

  async createConversation(input: {
    projectId: string;
    title?: string;
  }): Promise<ConversationRecord> {
    const id = randomUUID();
    const now = new Date().toISOString();

    await this.projectDatabase.transaction((database) => {
      database
        .prepare(
          `INSERT INTO conversations
           (id, project_id, title, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(id, input.projectId, input.title ?? null, now, now);
    });

    return {
      id,
      projectId: input.projectId,
      title: input.title ?? null,
      createdAt: now,
      updatedAt: now,
    };
  }

  getConversation(id: string): ConversationRecord | null {
    const row = this.projectDatabase.read(
      (database) =>
        database.prepare("SELECT * FROM conversations WHERE id = ?").get(id) as
          ConversationRow | undefined,
    );
    return row === undefined ? null : mapConversation(row);
  }

  getLatestConversation(projectId: string): ConversationSummary | null {
    const row = this.projectDatabase.read(
      (database) =>
        database
          .prepare(
            `SELECT c.*, COUNT(m.id) AS message_count
             FROM conversations c
             LEFT JOIN messages m ON m.conversation_id = c.id
             WHERE c.project_id = ?
             GROUP BY c.id
             ORDER BY c.updated_at DESC
             LIMIT 1`,
          )
          .get(projectId) as ConversationSummaryRow | undefined,
    );
    return row === undefined ? null : mapConversationSummary(row);
  }

  listConversations(projectId: string): ConversationSummary[] {
    const rows = this.projectDatabase.read(
      (database) =>
        database
          .prepare(
            `SELECT c.*, COUNT(m.id) AS message_count
             FROM conversations c
             LEFT JOIN messages m ON m.conversation_id = c.id
             WHERE c.project_id = ?
             GROUP BY c.id
             ORDER BY c.updated_at DESC`,
          )
          .all(projectId) as unknown as ConversationSummaryRow[],
    );
    return rows.map(mapConversationSummary);
  }

  getMessages(conversationId: string): StoredMessage[] {
    const rows = this.projectDatabase.read(
      (database) =>
        database
          .prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY sequence")
          .all(conversationId) as unknown as MessageRow[],
    );
    return rows.map(mapMessage);
  }

  getRecentVisibleMessages(conversationId: string, limit = 20): StoredMessage[] {
    // Read the newest user-visible messages without loading the complete conversation history.
    const rows = this.projectDatabase.read(
      (database) =>
        database
          .prepare(
            `SELECT * FROM messages
             WHERE conversation_id = ?
               AND role IN ('user', 'assistant')
               AND (
                 TRIM(content) <> ''
                 OR (role = 'assistant' AND TRIM(COALESCE(reasoning_content, '')) <> '')
               )
             ORDER BY sequence DESC
             LIMIT ?`,
          )
          .all(conversationId, limit) as unknown as MessageRow[],
    );
    return rows.reverse().map(mapMessage);
  }

  getToolMessages(conversationId: string, toolName: string): StoredMessage[] {
    const rows = this.projectDatabase.read(
      (database) =>
        database
          .prepare(
            `SELECT * FROM messages
             WHERE conversation_id = ? AND role = 'tool' AND name = ?
             ORDER BY sequence`,
          )
          .all(conversationId, toolName) as unknown as MessageRow[],
    );
    return rows.map(mapMessage);
  }

  async addMessage<Message extends ChatMessage>(
    conversationId: string,
    message: Message,
    sessionId: string,
    modelCallId: string | null = null,
  ): Promise<StoredMessage & Message> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const inserted = await this.projectDatabase.transaction((database) => {
      const exists = database
        .prepare("SELECT 1 AS found FROM conversations WHERE id = ?")
        .get(conversationId);
      if (exists === undefined) {
        throw new AppError("VALIDATION_ERROR", "指定的对话不存在。");
      }

      const row = database
        .prepare(
          "SELECT COALESCE(MAX(sequence), -1) + 1 AS next_sequence FROM messages WHERE conversation_id = ?",
        )
        .get(conversationId) as { next_sequence: number };
      const nextSequence = Number(row.next_sequence);
      const messageRowid = this.insertMessage(
        database,
        conversationId,
        message,
        nextSequence,
        now,
        id,
        sessionId,
        modelCallId,
      );
      database
        .prepare("UPDATE conversations SET updated_at = ? WHERE id = ?")
        .run(now, conversationId);
      return { messageRowid, sequence: nextSequence };
    });

    return {
      ...message,
      messageRowid: inserted.messageRowid,
      id,
      conversationId,
      sessionId,
      modelCallId,
      sequence: inserted.sequence,
      createdAt: now,
    };
  }

  private insertMessage(
    database: DatabaseSync,
    conversationId: string,
    message: ChatMessage,
    sequence: number,
    createdAt: string,
    id: string | undefined,
    sessionId: string,
    modelCallId: string | null = null,
  ): number {
    const messageId = id ?? randomUUID();
    const result = database
      .prepare(
        `INSERT INTO messages
         (id, conversation_id, sequence, role, content, reasoning_content, name, tool_call_id,
          tool_calls_json, created_at, session_id, model_call_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        messageId,
        conversationId,
        sequence,
        message.role,
        message.content,
        message.reasoningContent ?? null,
        message.name ?? null,
        message.toolCallId ?? null,
        message.toolCalls === undefined ? null : JSON.stringify(message.toolCalls),
        createdAt,
        sessionId,
        modelCallId,
      );
    return Number(result.lastInsertRowid);
  }
}

function mapConversation(row: ConversationRow): ConversationRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapConversationSummary(row: ConversationSummaryRow): ConversationSummary {
  return {
    ...mapConversation(row),
    messageCount: Number(row.message_count),
  };
}

function mapMessage(row: MessageRow): StoredMessage {
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
