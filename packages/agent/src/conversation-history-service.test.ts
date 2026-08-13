import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ConversationRepository,
  ProjectDatabase,
  SessionRepository,
} from "../../database/src/index.js";
import { TEST_DATABASE_OPTIONS } from "../../../test/runtime-options.js";
import { ConversationHistoryService } from "./conversation-history-service.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("ConversationHistoryService", () => {
  it("returns the latest twenty visible messages in display order", async () => {
    // Verify bounded history excludes internal roles and retains assistant reasoning.
    // 1. Create a conversation containing system, user, assistant, and tool messages.
    // 2. Add more than twenty visible messages so the oldest visible entry is excluded.
    // 3. Assert the result is bounded, ordered, and carries only the selected history.
    const fixture = await createFixture("project-a");
    try {
      const conversation = await fixture.conversations.createConversation({
        projectId: "project-a",
        providerId: "fake",
        model: "model",
        title: "章节讨论",
      });
      const session = await fixture.sessions.createInitialSession({
        conversationId: conversation.id,
        systemPrompt: "system",
      });
      await fixture.conversations.addMessage(
        conversation.id,
        { role: "system", content: "内部系统消息" },
        session.id,
      );
      await fixture.conversations.addMessage(
        conversation.id,
        { role: "tool", content: "内部工具结果", name: "tool" },
        session.id,
      );
      for (let index = 0; index < 21; index += 1) {
        await fixture.conversations.addMessage(
          conversation.id,
          index === 20
            ? { role: "assistant", content: "回答 20", reasoningContent: "思考 20" }
            : { role: index % 2 === 0 ? "user" : "assistant", content: `消息 ${index}` },
          session.id,
        );
      }

      const result = fixture.service.getRecentHistory(conversation.id);

      expect(result.messages).toHaveLength(20);
      expect(result.messages[0]?.content).toBe("消息 1");
      expect(result.messages.at(-1)).toMatchObject({
        role: "assistant",
        content: "回答 20",
        reasoningContent: "思考 20",
      });
      expect(result.messages.map((message) => message.role)).not.toContain("system");
      expect(result.messages.map((message) => message.role)).not.toContain("tool");
    } finally {
      await fixture.database.close();
    }
  });

  it("rejects a conversation owned by another project", async () => {
    // Verify the service cannot read a conversation outside its bound project identity.
    const fixture = await createFixture("project-a");
    try {
      const conversation = await fixture.conversations.createConversation({
        projectId: "project-b",
        providerId: "fake",
        model: "model",
      });

      expect(() => fixture.service.getRecentHistory(conversation.id)).toThrow(
        "指定的对话不属于当前项目",
      );
    } finally {
      await fixture.database.close();
    }
  });
});

async function createFixture(projectId: string): Promise<{
  readonly database: ProjectDatabase;
  readonly conversations: ConversationRepository;
  readonly sessions: SessionRepository;
  readonly service: ConversationHistoryService;
}> {
  // Open an isolated project database and its conversation services.
  const root = await mkdtemp(path.join(tmpdir(), "cleodoc-conversation-history-"));
  temporaryDirectories.push(root);
  const database = await ProjectDatabase.open(root, TEST_DATABASE_OPTIONS);
  return {
    database,
    conversations: new ConversationRepository(database),
    sessions: new SessionRepository(database),
    service: new ConversationHistoryService(database, projectId),
  };
}
