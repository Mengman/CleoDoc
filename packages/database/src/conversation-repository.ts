import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type {
  ChatMessage,
  ConversationRecord,
  ConversationSummary,
  GenerationRecord,
  GenerationStatus,
  ModelUsage,
  StoredMessage,
} from "../../contracts/src/index.js";
import { AppError } from "../../contracts/src/index.js";
import type { ProjectDatabase } from "./project-database.js";

interface ConversationRow {
  id: string;
  project_id: string;
  provider_id: string;
  model: string;
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

interface GenerationRow {
  id: string;
  conversation_id: string;
  provider_id: string;
  model: string;
  status: GenerationStatus;
  content: string;
  usage_json: string | null;
  error_code: string | null;
  saved_document_path: string | null;
  saved_content_hash: string | null;
  created_at: string;
  completed_at: string | null;
}

export class ConversationRepository {
  constructor(private readonly projectDatabase: ProjectDatabase) {}

  async createConversation(input: {
    projectId: string;
    providerId: string;
    model: string;
    title?: string;
  }): Promise<ConversationRecord> {
    const id = randomUUID();
    const now = new Date().toISOString();

    await this.projectDatabase.transaction((database) => {
      database
        .prepare(
          `INSERT INTO conversations
           (id, project_id, provider_id, model, title, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, input.projectId, input.providerId, input.model, input.title ?? null, now, now);
    });

    return {
      id,
      projectId: input.projectId,
      providerId: input.providerId,
      model: input.model,
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

  getLatestConversation(input: {
    projectId: string;
    providerId: string;
    model: string;
  }): ConversationSummary | null {
    const row = this.projectDatabase.read(
      (database) =>
        database
          .prepare(
            `SELECT c.*, COUNT(m.id) AS message_count
             FROM conversations c
             LEFT JOIN messages m ON m.conversation_id = c.id
             WHERE c.project_id = ? AND c.provider_id = ? AND c.model = ?
             GROUP BY c.id
             ORDER BY c.updated_at DESC
             LIMIT 1`,
          )
          .get(input.projectId, input.providerId, input.model) as
          ConversationSummaryRow | undefined,
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

  async beginGeneration(input: {
    conversationId: string;
    providerId: string;
    model: string;
  }): Promise<GenerationRecord> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.projectDatabase.write((database) => {
      database
        .prepare(
          `INSERT INTO generations
           (id, conversation_id, provider_id, model, status, content, created_at)
           VALUES (?, ?, ?, ?, 'running', '', ?)`,
        )
        .run(id, input.conversationId, input.providerId, input.model, now);
    });

    return {
      id,
      conversationId: input.conversationId,
      providerId: input.providerId,
      model: input.model,
      status: "running",
      content: "",
      usage: null,
      errorCode: null,
      savedDocumentPath: null,
      savedContentHash: null,
      createdAt: now,
      completedAt: null,
    };
  }

  async finishGeneration(input: {
    generationId: string;
    status: Exclude<GenerationStatus, "running">;
    content: string;
    usage?: ModelUsage;
    errorCode?: string;
    addAssistantMessage?: boolean;
    sessionId?: string;
    reasoningContent?: string;
    modelCallId?: string;
  }): Promise<(StoredMessage & { role: "assistant" }) | null> {
    const completedAt = new Date().toISOString();
    return this.projectDatabase.transaction((database) => {
      const row = database
        .prepare("SELECT conversation_id FROM generations WHERE id = ?")
        .get(input.generationId) as { conversation_id: string } | undefined;
      if (row === undefined) {
        throw new AppError("GENERATION_NOT_FOUND", "找不到生成记录。");
      }

      database
        .prepare(
          `UPDATE generations
           SET status = ?, content = ?, usage_json = ?, error_code = ?, completed_at = ?
           WHERE id = ?`,
        )
        .run(
          input.status,
          input.content,
          input.usage === undefined ? null : JSON.stringify(input.usage),
          input.errorCode ?? null,
          completedAt,
          input.generationId,
        );

      if (input.addAssistantMessage === true) {
        const sessionId = input.sessionId;
        if (sessionId === undefined) {
          throw new AppError("VALIDATION_ERROR", "写入 Assistant 消息时必须指定 Session。");
        }
        const sequenceRow = database
          .prepare(
            "SELECT COALESCE(MAX(sequence), -1) + 1 AS next_sequence FROM messages WHERE conversation_id = ?",
          )
          .get(row.conversation_id) as { next_sequence: number };
        const id = randomUUID();
        const sequence = Number(sequenceRow.next_sequence);
        const message = {
          role: "assistant",
          content: input.content,
          ...(input.reasoningContent === undefined
            ? {}
            : { reasoningContent: input.reasoningContent }),
        } as const satisfies ChatMessage;
        const messageRowid = this.insertMessage(
          database,
          row.conversation_id,
          message,
          sequence,
          completedAt,
          id,
          sessionId,
          input.modelCallId ?? null,
        );
        database
          .prepare("UPDATE conversations SET updated_at = ? WHERE id = ?")
          .run(completedAt, row.conversation_id);
        return {
          ...message,
          messageRowid,
          id,
          conversationId: row.conversation_id,
          sessionId,
          modelCallId: input.modelCallId ?? null,
          sequence,
          createdAt: completedAt,
        };
      }
      return null;
    });
  }

  getGeneration(id: string): GenerationRecord | null {
    const row = this.projectDatabase.read(
      (database) =>
        database.prepare("SELECT * FROM generations WHERE id = ?").get(id) as
          GenerationRow | undefined,
    );
    return row === undefined ? null : mapGeneration(row);
  }

  getLastCompletedGeneration(): GenerationRecord | null {
    const row = this.projectDatabase.read(
      (database) =>
        database
          .prepare(
            "SELECT * FROM generations WHERE status = 'completed' ORDER BY completed_at DESC LIMIT 1",
          )
          .get() as GenerationRow | undefined,
    );
    return row === undefined ? null : mapGeneration(row);
  }

  async markGenerationSaved(
    generationId: string,
    relativePath: string,
    contentHash: string,
  ): Promise<void> {
    await this.projectDatabase.write((database) => {
      const result = database
        .prepare(
          `UPDATE generations
           SET saved_document_path = ?, saved_content_hash = ?
           WHERE id = ? AND status = 'completed'`,
        )
        .run(relativePath, contentHash, generationId);
      if (Number(result.changes) !== 1) {
        throw new AppError("GENERATION_NOT_FOUND", "找不到可保存的完整生成结果。");
      }
    });
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
    providerId: row.provider_id,
    model: row.model,
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

function mapGeneration(row: GenerationRow): GenerationRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    providerId: row.provider_id,
    model: row.model,
    status: row.status,
    content: row.content,
    usage: row.usage_json === null ? null : (JSON.parse(row.usage_json) as ModelUsage),
    errorCode: row.error_code,
    savedDocumentPath: row.saved_document_path,
    savedContentHash: row.saved_content_hash,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}
