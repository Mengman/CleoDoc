import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  ModelEvent,
  ModelProvider,
  ModelRequest,
  ProviderHealth,
} from "../../contracts/src/index.js";
import { ProjectService } from "../../project/src/index.js";
import { ChatService } from "./chat-service.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("session compaction", () => {
  it("snapshots AGENTS, switches sessions, and lets the agent search closed history", async () => {
    const directory = await createTemporaryDirectory();
    const project = await new ProjectService().create(path.join(directory, "novel.cleo"));
    await writeFile(path.join(project.root, "AGENTS.md"), "第一版项目规则", "utf8");
    const provider = new CompactionAwareProvider();
    const chat = await ChatService.open(project.root);

    try {
      const first = await chat.send({
        projectId: project.manifest.id,
        provider,
        model: "scripted",
        prompt: "主角是一名退休刑警。",
        signal: new AbortController().signal,
      });
      expect(provider.requests[0]?.messages[0]?.content).toContain("第一版项目规则");

      await writeFile(path.join(project.root, "AGENTS.md"), "第二版项目规则", "utf8");
      await chat.compactConversation({
        conversationId: first.conversationId,
        provider,
        model: "scripted",
        contextWindowTokens: 8_000,
        trigger: "manual",
        signal: new AbortController().signal,
      });

      const sessions = chat.getSessions(first.conversationId);
      expect(sessions.map((session) => session.status)).toEqual(["closed", "active"]);
      expect(sessions[0]?.projectInstructionsSnapshot).toBe("第一版项目规则");
      expect(sessions[1]?.projectInstructionsSnapshot).toBe("第二版项目规则");

      await chat.send({
        conversationId: first.conversationId,
        projectId: project.manifest.id,
        provider,
        model: "scripted",
        prompt: "请找回主角的职业。",
        signal: new AbortController().signal,
      });

      const postCompaction = provider.requests.find(
        (request) =>
          !request.messages[0]?.content.includes("上下文压缩器") &&
          request.messages.some((message) => message.content === "请找回主角的职业。"),
      );
      expect(postCompaction?.messages[0]?.content).toContain("第二版项目规则");
      expect(postCompaction?.messages[0]?.content).toContain("<session_handoff");
      expect(
        postCompaction?.messages.some((message) => message.content === "主角是一名退休刑警。"),
      ).toBe(false);
      expect(
        provider.requests.some((request) =>
          request.messages.some(
            (message) => message.role === "tool" && message.content.includes("退休刑警"),
          ),
        ),
      ).toBe(true);
    } finally {
      await chat.close();
    }
  });

  it("keeps the old session active when summary validation fails twice", async () => {
    const directory = await createTemporaryDirectory();
    const project = await new ProjectService().create(path.join(directory, "novel.cleo"));
    const provider = new InvalidCompactionProvider();
    const chat = await ChatService.open(project.root);
    try {
      const first = await chat.send({
        projectId: project.manifest.id,
        provider,
        model: "scripted",
        prompt: "保留这一条历史。",
        signal: new AbortController().signal,
      });
      await expect(
        chat.compactConversation({
          conversationId: first.conversationId,
          provider,
          model: "scripted",
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      expect(chat.getSessions(first.conversationId)).toEqual([
        expect.objectContaining({ status: "active", compactionRequired: true }),
      ]);
      expect(
        chat.getConversationHistory(first.conversationId).map((message) => message.content),
      ).toEqual(expect.arrayContaining(["保留这一条历史。", "已记录。"]));
    } finally {
      await chat.close();
    }
  });

  it("uses hierarchical compaction when one request cannot hold the completed session", async () => {
    const directory = await createTemporaryDirectory();
    const project = await new ProjectService().create(path.join(directory, "novel.cleo"));
    const provider = new HierarchicalCompactionProvider();
    const chat = await ChatService.open(project.root);
    try {
      const first = await chat.send({
        projectId: project.manifest.id,
        provider,
        model: "scripted",
        prompt: "关键线索".repeat(900),
        signal: new AbortController().signal,
      });
      await chat.compactConversation({
        conversationId: first.conversationId,
        provider,
        model: "scripted",
        contextWindowTokens: 4_000,
        signal: new AbortController().signal,
      });
      expect(provider.compactionCalls).toBeGreaterThan(1);
      expect(chat.getSessions(first.conversationId).map((session) => session.status)).toEqual([
        "closed",
        "active",
      ]);
    } finally {
      await chat.close();
    }
  });
});

class CompactionAwareProvider implements ModelProvider {
  readonly id = "compaction-script";
  readonly displayName = "Compaction Script";
  readonly requests: ModelRequest[] = [];
  private normalCalls = 0;

  async validateConfiguration(): Promise<ProviderHealth> {
    return { ok: true, message: "ready" };
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    if (request.messages[0]?.content.includes("上下文压缩器")) {
      const payload = extractCompactionPayload(request.messages[1]!.content);
      const messages = payload.messages as Array<{ id: string }>;
      yield {
        type: "text-delta",
        text: JSON.stringify({
          schemaVersion: 1,
          sourceSessionId: payload.sourceSessionId,
          coveredMessages: {
            firstMessageId: messages[0]!.id,
            lastMessageId: messages.at(-1)!.id,
            count: messages.length,
          },
          conversationObjective: "继续创作小说",
          userDecisions: [{ text: "主角是退休刑警", sourceMessageIds: [messages[0]!.id] }],
          acceptedResults: [],
          rejectedDirections: [],
          aiSuggestions: [],
          constraints: [],
          unresolvedQuestions: [],
          pendingTasks: [],
          projectChanges: [],
          relevantDocuments: [],
          knownConflicts: [],
          detailLookupHints: [
            {
              topic: "主角职业",
              suggestedQuery: "退休刑警",
              sourceMessageIds: [messages[0]!.id],
            },
          ],
          handoffBrief: "用户已指定主角职业，需要时回查原话。",
        }),
      };
      yield { type: "done", finishReason: "stop" };
      return;
    }

    this.normalCalls += 1;
    if (this.normalCalls === 1) {
      yield { type: "text-delta", text: "已记录主角职业。" };
    } else if (this.normalCalls === 2) {
      yield {
        type: "tool-call",
        call: {
          id: "history-1",
          name: "search_conversation_history",
          argumentsJson: JSON.stringify({ query: "退休刑警" }),
        },
      };
    } else {
      yield { type: "text-delta", text: "历史显示主角是退休刑警。" };
    }
    yield { type: "done", finishReason: "stop" };
  }
}

class InvalidCompactionProvider implements ModelProvider {
  readonly id = "invalid-script";
  readonly displayName = "Invalid Script";

  async validateConfiguration(): Promise<ProviderHealth> {
    return { ok: true, message: "ready" };
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    yield {
      type: "text-delta",
      text: request.messages[0]?.content.includes("上下文压缩器") ? "{}" : "已记录。",
    };
    yield { type: "done", finishReason: "stop" };
  }
}

class HierarchicalCompactionProvider implements ModelProvider {
  readonly id = "hierarchical-script";
  readonly displayName = "Hierarchical Script";
  compactionCalls = 0;

  async validateConfiguration(): Promise<ProviderHealth> {
    return { ok: true, message: "ready" };
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    if (!request.messages[0]?.content.includes("上下文压缩器")) {
      yield { type: "text-delta", text: "已记录长线索。" };
      yield { type: "done", finishReason: "stop" };
      return;
    }
    this.compactionCalls += 1;
    const payload = extractCompactionPayload(request.messages[1]!.content);
    const covered = payload.coveredMessagesExpected as {
      firstMessageId: string;
      lastMessageId: string;
      count: number;
    };
    const allowed = payload.allowedSourceMessageIds as string[];
    yield {
      type: "text-delta",
      text: JSON.stringify({
        schemaVersion: 1,
        sourceSessionId: payload.sourceSessionId,
        coveredMessages: covered,
        conversationObjective: "保留长线索",
        userDecisions: [{ text: "用户提供了关键线索", sourceMessageIds: [allowed[0]] }],
        acceptedResults: [],
        rejectedDirections: [],
        aiSuggestions: [],
        constraints: [],
        unresolvedQuestions: [],
        pendingTasks: [],
        projectChanges: [],
        relevantDocuments: [],
        knownConflicts: [],
        detailLookupHints: [],
        handoffBrief: "已压缩长线索。",
      }),
    };
    yield { type: "done", finishReason: "stop" };
  }
}

function extractCompactionPayload(content: string): Record<string, unknown> {
  const prefix = "输入 JSON：\n";
  const suffix = "\n\n严格返回指定 JSON Schema。";
  const start = content.indexOf(prefix) + prefix.length;
  const end = content.lastIndexOf(suffix);
  return JSON.parse(content.slice(start, end)) as Record<string, unknown>;
}

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "cleodoc-session-test-"));
  temporaryDirectories.push(directory);
  return directory;
}
