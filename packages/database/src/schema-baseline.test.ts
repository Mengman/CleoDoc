import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { ConversationRepository } from "./conversation-repository.js";
import { CURRENT_SCHEMA_VERSION } from "./current-schema.js";
import { ProjectDatabase } from "./project-database.js";
import { TEST_DATABASE_OPTIONS } from "../../../test/runtime-options.js";
import { SessionRepository } from "./session-repository.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("current database schema baseline", () => {
  it("creates the complete v11 schema directly and preserves current FTS invariants", async () => {
    const root = await createTemporaryProject("cleodoc-schema-baseline-test-");
    const database = await ProjectDatabase.open(root, TEST_DATABASE_OPTIONS);
    try {
      expect(
        database.read(
          (sqlite) =>
            sqlite
              .prepare("SELECT version FROM schema_migrations ORDER BY version")
              .all() as Array<{
              version: number;
            }>,
        ),
      ).toEqual([{ version: CURRENT_SCHEMA_VERSION }]);

      const tableNames = database
        .read(
          (sqlite) =>
            sqlite
              .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
              .all() as Array<{ name: string }>,
        )
        .map((row) => row.name);
      expect(tableNames).toEqual(
        expect.arrayContaining([
          "compaction_job_model_call_mapping",
          "compaction_jobs",
          "chunk_embeddings",
          "conversation_message_fts",
          "conversation_sessions",
          "conversations",
          "generation_model_call_mapping",
          "generations",
          "embedding_models",
          "knowledge_chunk_fts",
          "knowledge_chunks",
          "messages",
          "model_calls",
          "project_instruction_revisions",
          "schema_migrations",
          "sources",
        ]),
      );
      expect(tableNames).not.toContain("session_summaries");
      expect(getColumnNames(database, "conversations")).not.toEqual(
        expect.arrayContaining(["provider_id", "model"]),
      );
      expect(getColumnNames(database, "generations")).not.toEqual(
        expect.arrayContaining(["provider_id", "model"]),
      );
      expect(getColumnNames(database, "compaction_jobs")).not.toEqual(
        expect.arrayContaining(["provider_id", "model", "summary_id"]),
      );
      expect(getColumnNames(database, "compaction_jobs")).toContain("summary");

      const messageColumns = getColumnNames(database, "messages");
      expect(messageColumns).toEqual(
        expect.arrayContaining(["message_rowid", "reasoning_content", "model_call_id"]),
      );
      expect(getColumnNames(database, "conversation_message_fts")).toEqual(["content"]);
      expect(getColumnNames(database, "knowledge_chunk_fts")).toEqual(["content"]);
      expect(getColumnNames(database, "knowledge_chunks")).toContain("content_hash");
      expect(getColumnNames(database, "sources")).toEqual(
        expect.arrayContaining([
          "parser_version",
          "languages_json",
          "chunker_version",
          "chunking_config_json",
          "index_status",
          "index_error_code",
          "indexed_at",
        ]),
      );
      expect(getColumnNames(database, "sources")).not.toContain("tags_json");
      expect(
        database.read(
          (sqlite) =>
            (
              sqlite.prepare("PRAGMA table_info(messages)").all() as Array<{
                name: string;
                notnull: number;
              }>
            ).find((column) => column.name === "session_id")?.notnull,
        ),
      ).toBe(1);
      expect(
        database.read(
          (sqlite) =>
            (
              sqlite
                .prepare(
                  "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'compaction_job_model_call_mapping'",
                )
                .get() as { sql: string }
            ).sql,
        ),
      ).not.toContain("repair");
      expect(getColumnNames(database, "conversation_sessions")).not.toEqual(
        expect.arrayContaining([
          "project_instructions_path",
          "project_instructions_snapshot",
          "project_instructions_hash",
          "project_instructions_loaded_at",
        ]),
      );
      expect(
        database.read((sqlite) =>
          sqlite
            .prepare(
              "SELECT name FROM sqlite_master WHERE name = 'conversation_message_fts_content'",
            )
            .get(),
        ),
      ).toBeUndefined();
      expect(
        database.read((sqlite) =>
          sqlite
            .prepare("SELECT name FROM sqlite_master WHERE name = 'knowledge_chunk_fts_content'")
            .get(),
        ),
      ).toBeUndefined();

      const conversations = new ConversationRepository(database);
      const conversation = await conversations.createConversation({
        projectId: "project-1",
      });
      const sessions = new SessionRepository(database);
      const session = await sessions.createInitialSession({
        conversationId: conversation.id,
        systemPrompt: "system prompt",
      });
      const message = await conversations.addMessage(
        conversation.id,
        { role: "user", content: "不可丢失的当前消息" },
        session.id,
      );
      await database.write((sqlite) =>
        sqlite
          .prepare("UPDATE conversation_sessions SET status = 'closed' WHERE id = ?")
          .run(session.id),
      );

      expect(
        sessions.searchClosedHistory({
          conversationId: conversation.id,
          query: "不可丢失",
          limit: 5,
        }),
      ).toEqual([expect.objectContaining({ messageId: message.id, excerpt: expect.any(String) })]);
      await expect(
        database.write((sqlite) =>
          sqlite.prepare("UPDATE messages SET content = '不允许修改' WHERE id = ?").run(message.id),
        ),
      ).rejects.toMatchObject({ code: "DATABASE_ERROR" });
      await database.write((sqlite) =>
        sqlite.prepare("DELETE FROM conversations WHERE id = ?").run(conversation.id),
      );
      expect(
        database.read((sqlite) =>
          sqlite
            .prepare(
              `SELECT COUNT(*) AS count FROM conversation_message_fts
               WHERE conversation_message_fts MATCH '"不可丢失"'`,
            )
            .get(),
        ),
      ).toEqual({ count: 0 });
    } finally {
      await database.close();
    }
  });

  it("rejects an incomplete development database instead of applying the baseline over it", async () => {
    const root = await createTemporaryProject("cleodoc-unsupported-schema-test-");
    const state = path.join(root, ".cleo");
    await mkdir(state, { recursive: true });
    const raw = new DatabaseSync(path.join(state, "project.sqlite"));
    raw.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations(version, applied_at)
      VALUES (7, '2026-01-01T00:00:00.000Z');
      CREATE TABLE conversations (id TEXT PRIMARY KEY);
    `);
    raw.close();

    await expect(ProjectDatabase.open(root, TEST_DATABASE_OPTIONS)).rejects.toMatchObject({
      code: "DATABASE_ERROR",
      message: expect.stringContaining("v7"),
    });

    const unchanged = new DatabaseSync(path.join(state, "project.sqlite"));
    try {
      expect(unchanged.prepare("SELECT version FROM schema_migrations").all()).toEqual([
        { version: 7 },
      ]);
      expect(
        unchanged.prepare("SELECT name FROM sqlite_master WHERE name = 'messages'").get(),
      ).toBeUndefined();
    } finally {
      unchanged.close();
    }
  });

  it("migrates v10 conversations and completed compaction summaries without losing audit links", async () => {
    const root = await createTemporaryProject("cleodoc-v10-migration-test-");
    const state = path.join(root, ".cleo");
    await mkdir(state, { recursive: true });
    const raw = new DatabaseSync(path.join(state, "project.sqlite"));
    createV10ConversationFixture(raw);
    raw.close();

    const database = await ProjectDatabase.open(root, TEST_DATABASE_OPTIONS);
    try {
      expect(database.read((sqlite) => sqlite.prepare("PRAGMA foreign_key_check").all())).toEqual(
        [],
      );
      expect(getColumnNames(database, "conversations")).not.toContain("provider_id");
      expect(getColumnNames(database, "generations")).not.toContain("model");
      expect(getColumnNames(database, "compaction_jobs")).toContain("summary");
      expect(
        database.read((sqlite) =>
          sqlite.prepare("SELECT id, project_id, title FROM conversations").get(),
        ),
      ).toEqual({ id: "conversation-1", project_id: "project-1", title: "测试对话" });
      expect(
        database.read((sqlite) =>
          sqlite
            .prepare("SELECT id, status, content FROM generations WHERE id = 'generation-1'")
            .get(),
        ),
      ).toEqual({ id: "generation-1", status: "completed", content: "模型回复" });
      expect(
        database.read((sqlite) =>
          sqlite
            .prepare(
              "SELECT id, source_session_id, summary FROM compaction_jobs WHERE id = 'job-1'",
            )
            .get(),
        ),
      ).toEqual({ id: "job-1", source_session_id: "session-1", summary: "累计摘要" });
      expect(
        database.read((sqlite) =>
          sqlite
            .prepare(
              "SELECT inherited_compaction_job_id FROM conversation_sessions WHERE id = 'session-2'",
            )
            .get(),
        ),
      ).toEqual({ inherited_compaction_job_id: "job-1" });
      expect(
        database.read((sqlite) =>
          sqlite.prepare("SELECT COUNT(*) AS count FROM model_calls").get(),
        ),
      ).toEqual({ count: 2 });
      expect(
        database.read((sqlite) => sqlite.prepare("SELECT COUNT(*) AS count FROM messages").get()),
      ).toEqual({ count: 2 });
      await database.write((sqlite) =>
        sqlite.prepare("DELETE FROM conversations WHERE id = 'conversation-1'").run(),
      );
      expect(database.read((sqlite) => sqlite.prepare("PRAGMA foreign_key_check").all())).toEqual(
        [],
      );
    } finally {
      await database.close();
    }
  });
});

function createV10ConversationFixture(database: DatabaseSync): void {
  // Create the v10 conversation subsystem and one completed compaction chain.
  // 1. Define the old coupled tables and their audit mappings.
  // 2. Insert one conversation, generation, and two linked Sessions.
  // 3. Link a completed Summary and Job to retained model-call audit rows.
  database.exec(`
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    INSERT INTO schema_migrations VALUES (10, '2026-01-01T00:00:00.000Z');
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, provider_id TEXT NOT NULL,
      model TEXT NOT NULL, title TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE generations (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      provider_id TEXT NOT NULL, model TEXT NOT NULL, status TEXT NOT NULL, content TEXT NOT NULL,
      usage_json TEXT, error_code TEXT, saved_document_path TEXT, saved_content_hash TEXT,
      created_at TEXT NOT NULL, completed_at TEXT
    );
    CREATE TABLE conversation_sessions (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL, status TEXT NOT NULL, trigger TEXT NOT NULL,
      system_prompt_snapshot TEXT NOT NULL, inherited_summary_id TEXT,
      estimated_input_tokens INTEGER NOT NULL, actual_input_tokens INTEGER,
      compaction_required INTEGER NOT NULL, started_at TEXT NOT NULL, closed_at TEXT
    );
    CREATE TABLE session_summaries (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      source_session_id TEXT NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE, summary TEXT NOT NULL,
      first_message_id TEXT NOT NULL, last_message_id TEXT NOT NULL, message_count INTEGER NOT NULL,
      prompt_version TEXT NOT NULL, provider_id TEXT NOT NULL, model TEXT NOT NULL,
      usage_json TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE compaction_jobs (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      source_session_id TEXT NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE, previous_summary_id TEXT,
      status TEXT NOT NULL, trigger TEXT NOT NULL, provider_id TEXT NOT NULL, model TEXT NOT NULL,
      prompt_version TEXT NOT NULL, first_message_id TEXT NOT NULL, last_message_id TEXT NOT NULL,
      message_count INTEGER NOT NULL, attempt_count INTEGER NOT NULL,
      orchestration_config_json TEXT NOT NULL, usage_json TEXT, summary_id TEXT,
      error_code TEXT, created_at TEXT NOT NULL, completed_at TEXT
    );
    CREATE TABLE model_calls (
      id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, model TEXT NOT NULL,
      request_options_json TEXT NOT NULL, status TEXT NOT NULL, finish_reason TEXT,
      error_code TEXT, prompt_tokens INTEGER, completion_tokens INTEGER,
      reasoning_tokens INTEGER, total_tokens INTEGER, created_at TEXT NOT NULL, completed_at TEXT
    );
    CREATE TABLE generation_model_call_mapping (
      generation_id TEXT NOT NULL REFERENCES generations(id) ON DELETE CASCADE,
      model_call_id TEXT NOT NULL REFERENCES model_calls(id) ON DELETE CASCADE, ordinal INTEGER NOT NULL
    );
    CREATE TABLE compaction_job_model_call_mapping (
      compaction_job_id TEXT NOT NULL REFERENCES compaction_jobs(id) ON DELETE CASCADE,
      model_call_id TEXT NOT NULL REFERENCES model_calls(id) ON DELETE CASCADE, ordinal INTEGER NOT NULL,
      phase TEXT NOT NULL, segment_index INTEGER
    );
    CREATE TABLE messages (
      message_rowid INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, sequence INTEGER NOT NULL,
      role TEXT NOT NULL, content TEXT NOT NULL, reasoning_content TEXT, name TEXT,
      tool_call_id TEXT, tool_calls_json TEXT, created_at TEXT NOT NULL,
      session_id TEXT NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
      model_call_id TEXT REFERENCES model_calls(id)
    );

    INSERT INTO conversations VALUES
      ('conversation-1', 'project-1', 'openai-compatible', 'old-model', '测试对话',
       '2026-01-01T00:00:00.000Z', '2026-01-01T00:05:00.000Z');
    INSERT INTO conversation_sessions VALUES
      ('session-1', 'conversation-1', 1, 'closed', 'conversation_started', 'system', NULL,
       100, 90, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:03:00.000Z'),
      ('session-2', 'conversation-1', 2, 'active', 'manual', 'system', 'summary-1',
       0, NULL, 0, '2026-01-01T00:03:00.000Z', NULL);
    INSERT INTO session_summaries VALUES
      ('summary-1', 'conversation-1', 'session-1', '累计摘要', 'message-1', 'message-1', 1,
       'prompt-v1', 'openai-compatible', 'old-model', '{}', '2026-01-01T00:03:00.000Z');
    INSERT INTO compaction_jobs VALUES
      ('job-1', 'conversation-1', 'session-1', NULL, 'completed', 'manual',
       'openai-compatible', 'old-model', 'prompt-v1', 'message-1', 'message-1', 1, 1,
       '{}', '{}', 'summary-1', NULL, '2026-01-01T00:02:00.000Z', '2026-01-01T00:03:00.000Z');
    INSERT INTO generations VALUES
      ('generation-1', 'conversation-1', 'openai-compatible', 'old-model', 'completed',
       '模型回复', '{}', NULL, NULL, NULL, '2026-01-01T00:01:00.000Z',
       '2026-01-01T00:01:10.000Z');
    INSERT INTO model_calls VALUES
      ('call-1', 'openai-compatible', 'old-model', '{}', 'completed', 'stop', NULL,
       10, 5, 0, 15, '2026-01-01T00:01:00.000Z', '2026-01-01T00:01:10.000Z'),
      ('call-2', 'openai-compatible', 'old-model', '{}', 'completed', 'stop', NULL,
       20, 8, 0, 28, '2026-01-01T00:02:00.000Z', '2026-01-01T00:03:00.000Z');
    INSERT INTO generation_model_call_mapping VALUES ('generation-1', 'call-1', 1);
    INSERT INTO compaction_job_model_call_mapping VALUES ('job-1', 'call-2', 1, 'primary', NULL);
    INSERT INTO messages VALUES
      (1, 'message-1', 'conversation-1', 1, 'user', '用户消息', NULL, NULL, NULL, NULL,
       '2026-01-01T00:00:30.000Z', 'session-1', NULL),
      (2, 'message-2', 'conversation-1', 2, 'assistant', '模型回复', NULL, NULL, NULL, NULL,
       '2026-01-01T00:01:10.000Z', 'session-2', 'call-1');
  `);
}

async function createTemporaryProject(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(root);
  return root;
}

function getColumnNames(database: ProjectDatabase, table: string): string[] {
  return database
    .read(
      (sqlite) =>
        sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{
          name: string;
        }>,
    )
    .map((column) => column.name);
}
