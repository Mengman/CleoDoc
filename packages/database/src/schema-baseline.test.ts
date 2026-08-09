import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { ConversationRepository } from "./conversation-repository.js";
import {
  CURRENT_SCHEMA_SQL,
  CURRENT_SCHEMA_VERSION,
  KNOWLEDGE_INDEX_SCHEMA_SQL,
} from "./current-schema.js";
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
  it("creates the complete v10 schema directly and preserves current FTS invariants", async () => {
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
          "conversation_message_fts",
          "conversation_sessions",
          "conversations",
          "generation_model_call_mapping",
          "generations",
          "knowledge_chunk_fts",
          "knowledge_chunks",
          "messages",
          "model_calls",
          "project_instruction_revisions",
          "schema_migrations",
          "session_summaries",
          "sources",
        ]),
      );

      const messageColumns = getColumnNames(database, "messages");
      expect(messageColumns).toEqual(
        expect.arrayContaining(["message_rowid", "reasoning_content", "model_call_id"]),
      );
      expect(getColumnNames(database, "conversation_message_fts")).toEqual(["content"]);
      expect(getColumnNames(database, "knowledge_chunk_fts")).toEqual(["content"]);
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
        providerId: "fake",
        model: "model",
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

  it("migrates a complete v8 database to v10 without rewriting its data or history", async () => {
    const root = await createTemporaryProject("cleodoc-existing-v8-test-");
    const state = path.join(root, ".cleo");
    await mkdir(state, { recursive: true });
    const filePath = path.join(root, ".cleo", "project.sqlite");
    const raw = new DatabaseSync(filePath);
    raw.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      ${v8SchemaSql()}
      INSERT INTO schema_migrations(version, applied_at)
      VALUES (8, '2026-01-01T00:00:00.000Z');
      INSERT INTO conversations
        (id, project_id, provider_id, model, title, created_at, updated_at)
      VALUES
        ('conversation-1', 'project-1', 'fake', 'model', '保留的对话',
         '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      INSERT INTO conversation_sessions
        (id, conversation_id, ordinal, status, trigger, system_prompt_snapshot,
         estimated_input_tokens, compaction_required, started_at)
      VALUES
        ('session-1', 'conversation-1', 1, 'active', 'conversation_started', 'system prompt',
         0, 0, '2026-01-01T00:00:00.000Z');
      INSERT INTO messages
        (id, conversation_id, sequence, role, content, created_at, session_id)
      VALUES
        ('message-1', 'conversation-1', 1, 'user', '已经完成迁移的数据',
         '2026-01-01T00:00:00.000Z', 'session-1');
      INSERT INTO sources
        (id, project_id, source_type, origin, format, title, tags_json, relative_path,
         content_hash, size, created_at, updated_at)
      VALUES
        ('source-1', 'project-1', 'material', 'file', 'markdown', '待索引资料', '[]',
         'materials/00000000-0000-0000-0000-000000000001.md',
         '0000000000000000000000000000000000000000000000000000000000000000', 10,
         '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    `);
    raw.close();

    const reopened = await ProjectDatabase.open(root, TEST_DATABASE_OPTIONS);
    try {
      expect(new ConversationRepository(reopened).getConversation("conversation-1")).toMatchObject({
        id: "conversation-1",
        title: "保留的对话",
      });
      expect(new ConversationRepository(reopened).getMessages("conversation-1")).toEqual([
        expect.objectContaining({
          id: "message-1",
          sessionId: "session-1",
          content: "已经完成迁移的数据",
        }),
      ]);
      expect(
        reopened.read((sqlite) =>
          sqlite.prepare("SELECT version FROM schema_migrations ORDER BY version").all(),
        ),
      ).toEqual([{ version: 8 }, { version: 9 }, { version: 10 }]);
      expect(getColumnNames(reopened, "knowledge_chunks")).toContain("chunk_id");
      expect(getColumnNames(reopened, "sources")).toContain("index_status");
      expect(
        reopened.read((sqlite) =>
          sqlite.prepare("SELECT index_status FROM sources WHERE id = 'source-1'").get(),
        ),
      ).toEqual({ index_status: "pending" });
      expect(
        reopened.read((sqlite) =>
          sqlite.prepare("SELECT languages_json FROM sources WHERE id = 'source-1'").get(),
        ),
      ).toEqual({ languages_json: '["zh"]' });
    } finally {
      await reopened.close();
    }
  });

  it("migrates a complete v9 database to v10 and defaults existing sources to Chinese", async () => {
    const root = await createTemporaryProject("cleodoc-existing-v9-test-");
    const state = path.join(root, ".cleo");
    await mkdir(state, { recursive: true });
    const raw = new DatabaseSync(path.join(state, "project.sqlite"));
    raw.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      ${v9SchemaSql()}
      INSERT INTO schema_migrations(version, applied_at)
      VALUES (9, '2026-01-01T00:00:00.000Z');
      INSERT INTO sources
        (id, project_id, source_type, origin, format, title, tags_json, relative_path,
         content_hash, size, created_at, updated_at)
      VALUES
        ('source-1', 'project-1', 'material', 'file', 'markdown', '既有资料', '[]',
         'materials/00000000-0000-0000-0000-000000000001.md',
         '0000000000000000000000000000000000000000000000000000000000000000', 10,
         '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    `);
    raw.close();

    const reopened = await ProjectDatabase.open(root, TEST_DATABASE_OPTIONS);
    try {
      expect(
        reopened.read((sqlite) =>
          sqlite.prepare("SELECT version FROM schema_migrations ORDER BY version").all(),
        ),
      ).toEqual([{ version: 9 }, { version: 10 }]);
      expect(
        reopened.read((sqlite) =>
          sqlite.prepare("SELECT languages_json FROM sources WHERE id = 'source-1'").get(),
        ),
      ).toEqual({ languages_json: '["zh"]' });
    } finally {
      await reopened.close();
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
});

async function createTemporaryProject(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(root);
  return root;
}

function v8SchemaSql(): string {
  return v9SchemaSql()
    .replace(KNOWLEDGE_INDEX_SCHEMA_SQL, "")
    .replace(
      `    parser_version TEXT,
    chunker_version TEXT,
    chunking_config_json TEXT,
    index_status TEXT NOT NULL DEFAULT 'pending'
      CHECK (index_status IN ('pending', 'ready', 'stale', 'failed')),
    index_error_code TEXT,
    indexed_at TEXT,
`,
      "",
    );
}

function v9SchemaSql(): string {
  return CURRENT_SCHEMA_SQL.replace(`    languages_json TEXT NOT NULL DEFAULT '["zh"]',\n`, "");
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
