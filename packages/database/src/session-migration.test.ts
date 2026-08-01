import { mkdir, mkdtemp, rm } from "node:fs/promises";
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
          id: "message-1",
          sessionId: "legacy-conversation-1",
          content: "不可丢失的旧消息",
        }),
      ]);
    } finally {
      await database.close();
    }
  });
});
