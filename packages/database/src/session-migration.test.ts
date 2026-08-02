import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { ConversationRepository } from "./conversation-repository.js";
import { migrations } from "./migrations.js";
import { ProjectDatabase } from "./project-database.js";
import { SessionRepository } from "./session-repository.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("session migration", () => {
  it("binds existing messages to one legacy session without changing their content", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cleodoc-migration-test-"));
    temporaryDirectories.push(root);
    const state = path.join(root, ".cleo");
    await mkdir(state, { recursive: true });
    const raw = new DatabaseSync(path.join(state, "project.sqlite"));
    raw.exec(
      "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
    );
    for (const migration of migrations.filter((item) => item.version <= 3)) {
      raw.exec(migration.sql);
      raw
        .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
        .run(migration.version, "2026-01-01T00:00:00.000Z");
    }
    raw
      .prepare(
        `INSERT INTO conversations
         (id, project_id, provider_id, model, title, created_at, updated_at)
         VALUES ('conversation-1', 'project-1', 'fake', 'model', '旧对话', ?, ?)`,
      )
      .run("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    raw
      .prepare(
        `INSERT INTO messages
         (id, conversation_id, sequence, role, content, name, tool_call_id, created_at, tool_calls_json)
         VALUES ('message-1', 'conversation-1', 0, 'user', '不可丢失的旧消息', NULL, NULL, ?, NULL)`,
      )
      .run("2026-01-01T00:00:00.000Z");
    raw.close();

    const database = await ProjectDatabase.open(root);
    try {
      const sessions = new SessionRepository(database);
      const current = sessions.getCurrentSession("conversation-1");
      expect(current).toMatchObject({ id: "legacy-conversation-1", ordinal: 1, status: "active" });
      expect(new ConversationRepository(database).getMessages("conversation-1")).toEqual([
        expect.objectContaining({
          messageRowid: expect.any(Number),
          id: "message-1",
          sessionId: "legacy-conversation-1",
          content: "不可丢失的旧消息",
        }),
      ]);
      expect(
        database
          .read(
            (sqlite) =>
              sqlite.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>,
          )
          .map((column) => column.name),
      ).toEqual(expect.arrayContaining(["message_rowid", "reasoning_content", "model_call_id"]));
      expect(
        database
          .read(
            (sqlite) =>
              sqlite.prepare("PRAGMA table_info(conversation_message_fts)").all() as Array<{
                name: string;
              }>,
          )
          .map((column) => column.name),
      ).toEqual(["content"]);
      expect(
        database.read((sqlite) =>
          sqlite
            .prepare(
              "SELECT name FROM sqlite_master WHERE name = 'conversation_message_fts_content'",
            )
            .get(),
        ),
      ).toBeUndefined();

      await database.write((sqlite) =>
        sqlite
          .prepare("UPDATE conversation_sessions SET status = 'closed' WHERE id = ?")
          .run("legacy-conversation-1"),
      );
      expect(
        new SessionRepository(database).searchClosedHistory({
          conversationId: "conversation-1",
          query: "不可丢失",
          limit: 5,
        }),
      ).toEqual([expect.objectContaining({ messageId: "message-1", excerpt: expect.any(String) })]);
      await expect(
        database.write((sqlite) =>
          sqlite
            .prepare("UPDATE messages SET content = '不允许修改' WHERE id = ?")
            .run("message-1"),
        ),
      ).rejects.toMatchObject({ code: "DATABASE_ERROR" });
      await database.write((sqlite) =>
        sqlite.prepare("DELETE FROM conversations WHERE id = ?").run("conversation-1"),
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

  it("migrates legacy structured summaries to one Markdown summary without breaking links", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cleodoc-summary-migration-test-"));
    temporaryDirectories.push(root);
    const state = path.join(root, ".cleo");
    await mkdir(state, { recursive: true });
    const raw = new DatabaseSync(path.join(state, "project.sqlite"));
    raw.exec(
      "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
    );
    for (const migration of migrations.filter((item) => item.version <= 4)) {
      raw.exec(migration.sql);
      raw
        .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
        .run(migration.version, "2026-01-01T00:00:00.000Z");
    }

    const createdAt = "2026-01-01T00:00:00.000Z";
    raw
      .prepare(
        `INSERT INTO conversations
         (id, project_id, provider_id, model, title, created_at, updated_at)
         VALUES ('conversation-1', 'project-1', 'fake', 'model', '迁移对话', ?, ?)`,
      )
      .run(createdAt, createdAt);
    raw
      .prepare(
        `INSERT INTO conversation_sessions
         (id, conversation_id, ordinal, status, trigger, system_prompt_snapshot,
          project_instructions_loaded_at, inherited_summary_id, started_at, closed_at)
         VALUES
         ('session-1', 'conversation-1', 1, 'closed', 'conversation_started', '', ?, NULL, ?, ?),
         ('session-2', 'conversation-1', 2, 'active', 'manual', '', ?, 'summary-1', ?, NULL)`,
      )
      .run(createdAt, createdAt, createdAt, createdAt, createdAt);
    raw
      .prepare(
        `INSERT INTO messages
         (id, conversation_id, sequence, role, content, created_at, session_id)
         VALUES
         ('message-1', 'conversation-1', 1, 'user', '主角必须是退休刑警。', ?, 'session-1'),
         ('message-2', 'conversation-1', 2, 'assistant', '已经记录。', ?, 'session-1')`,
      )
      .run(createdAt, createdAt);

    const legacySummary = {
      schemaVersion: 1,
      sourceSessionId: "session-1",
      coveredMessages: {
        firstMessageId: "message-1",
        lastMessageId: "message-2",
        count: 2,
      },
      conversationObjective: "继续创作悬疑小说",
      userDecisions: [{ text: "主角是退休刑警", sourceMessageIds: ["message-1"] }],
      acceptedResults: [],
      rejectedDirections: [],
      aiSuggestions: [],
      constraints: [],
      unresolvedQuestions: [],
      pendingTasks: [{ text: "设计第一章案发现场", sourceMessageIds: ["message-2"] }],
      projectChanges: [],
      relevantDocuments: [],
      knownConflicts: [],
      detailLookupHints: [
        {
          topic: "主角职业",
          suggestedQuery: "退休刑警",
          sourceMessageIds: ["message-1"],
        },
      ],
      handoffBrief: "用户已经确定主角职业。",
    };
    const legacyJson = JSON.stringify(legacySummary);
    raw
      .prepare(
        `INSERT INTO session_summaries
         (id, conversation_id, source_session_id, content_json, handoff_text, prompt_version,
          provider_id, model, usage_json, parameters_json, validation_status,
          first_message_id, last_message_id, message_count, created_at)
         VALUES ('summary-1', 'conversation-1', 'session-1', ?, ?, 'session-compaction-v6',
                 'fake', 'model', '{"inputTokens":100}', '{}', 'validated',
                 'message-1', 'message-2', 2, ?)`,
      )
      .run(legacyJson, legacyJson, createdAt);
    raw
      .prepare(
        `INSERT INTO compaction_jobs
         (id, conversation_id, source_session_id, status, trigger, provider_id, model,
          prompt_version, first_message_id, last_message_id, message_count, parameters_json,
          summary_id, created_at, completed_at)
         VALUES ('job-1', 'conversation-1', 'session-1', 'completed', 'manual', 'fake', 'model',
                 'session-compaction-v6', 'message-1', 'message-2', 2, '{}', 'summary-1', ?, ?)`,
      )
      .run(createdAt, createdAt);
    raw.close();

    const database = await ProjectDatabase.open(root);
    try {
      const columns = database.read(
        (sqlite) =>
          sqlite.prepare("PRAGMA table_info(session_summaries)").all() as Array<{ name: string }>,
      );
      expect(columns.map((column) => column.name)).toEqual([
        "id",
        "conversation_id",
        "source_session_id",
        "summary",
        "first_message_id",
        "last_message_id",
        "message_count",
        "prompt_version",
        "provider_id",
        "model",
        "usage_json",
        "created_at",
      ]);

      const sessions = new SessionRepository(database);
      const migrated = sessions.getLatestSummary("conversation-1");
      expect(migrated).toMatchObject({
        id: "summary-1",
        sourceSessionId: "session-1",
        firstMessageId: "message-1",
        lastMessageId: "message-2",
        messageCount: 2,
        usage: { inputTokens: 100 },
      });
      expect(migrated?.summary).toContain("# 交接摘要\n\n用户已经确定主角职业。");
      expect(migrated?.summary).toContain("# 已确认决定\n\n- 主角是退休刑警");
      expect(migrated?.summary).toContain("# 下一步\n\n- 设计第一章案发现场");

      expect(sessions.listSessions("conversation-1")[1]?.inheritedSummaryId).toBe("summary-1");
      expect(
        database.read(
          (sqlite) =>
            (
              sqlite.prepare("SELECT summary_id FROM compaction_jobs WHERE id = 'job-1'").get() as {
                summary_id: string;
              }
            ).summary_id,
        ),
      ).toBe("summary-1");
      expect(
        database.read(
          (sqlite) =>
            (
              sqlite.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as {
                version: number;
              }
            ).version,
        ),
      ).toBe(6);
      expect(await readdir(path.join(state, "backups"))).toEqual([
        expect.stringMatching(/^pre-migration-v5-.*\.sqlite$/),
      ]);
    } finally {
      await database.close();
    }
  });

  it("preserves the compatibility text when a legacy summary cannot be parsed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cleodoc-summary-fallback-test-"));
    temporaryDirectories.push(root);
    const state = path.join(root, ".cleo");
    await mkdir(state, { recursive: true });
    const raw = new DatabaseSync(path.join(state, "project.sqlite"));
    raw.exec(
      "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
    );
    for (const migration of migrations.filter((item) => item.version <= 4)) {
      raw.exec(migration.sql);
      raw
        .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
        .run(migration.version, "2026-01-01T00:00:00.000Z");
    }
    const createdAt = "2026-01-01T00:00:00.000Z";
    raw.exec(`
      INSERT INTO conversations
        (id, project_id, provider_id, model, created_at, updated_at)
      VALUES ('conversation-2', 'project-1', 'fake', 'model', '${createdAt}', '${createdAt}');
      INSERT INTO conversation_sessions
        (id, conversation_id, ordinal, status, trigger, system_prompt_snapshot,
         project_instructions_loaded_at, started_at, closed_at)
      VALUES ('session-fallback', 'conversation-2', 1, 'closed', 'conversation_started', '',
              '${createdAt}', '${createdAt}', '${createdAt}');
      INSERT INTO session_summaries
        (id, conversation_id, source_session_id, content_json, handoff_text, prompt_version,
         provider_id, model, parameters_json, validation_status,
         first_message_id, last_message_id, message_count, created_at)
      VALUES ('summary-fallback', 'conversation-2', 'session-fallback', 'not-json',
              '# 兼容摘要\n\n保留这段旧内容。', 'session-compaction-v6', 'fake', 'model',
              '{}', 'validated', 'message-a', 'message-b', 2, '${createdAt}');
      INSERT INTO conversations
        (id, project_id, provider_id, model, created_at, updated_at)
      VALUES ('conversation-3', 'project-1', 'fake', 'model', '${createdAt}', '${createdAt}');
      INSERT INTO conversation_sessions
        (id, conversation_id, ordinal, status, trigger, system_prompt_snapshot,
         project_instructions_loaded_at, started_at, closed_at)
      VALUES ('session-bridge', 'conversation-3', 1, 'closed', 'conversation_started', '',
              '${createdAt}', '${createdAt}', '${createdAt}');
      INSERT INTO session_summaries
        (id, conversation_id, source_session_id, content_json, handoff_text, prompt_version,
         provider_id, model, parameters_json, validation_status,
         first_message_id, last_message_id, message_count, created_at)
      VALUES ('summary-bridge', 'conversation-3', 'session-bridge', '{}',
              '# 已确认决定\n\n- 保持 v7 Markdown 原样。', 'session-compaction-v7', 'fake', 'model',
              '{}', 'validated', 'message-c', 'message-d', 2, '${createdAt}');
    `);
    raw.close();

    const database = await ProjectDatabase.open(root);
    try {
      expect(new SessionRepository(database).getLatestSummary("conversation-2")?.summary).toBe(
        "# 兼容摘要\n\n保留这段旧内容。",
      );
      expect(new SessionRepository(database).getLatestSummary("conversation-3")?.summary).toBe(
        "# 已确认决定\n\n- 保持 v7 Markdown 原样。",
      );
    } finally {
      await database.close();
    }
  });
});
