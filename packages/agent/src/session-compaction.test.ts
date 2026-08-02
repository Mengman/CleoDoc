import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import type {
  ModelEvent,
  ModelProvider,
  ModelRequest,
  ProviderHealth,
  StoredMessage,
} from "../../contracts/src/index.js";
import { ProjectDatabase, ProjectInstructionRepository } from "../../database/src/index.js";
import { ProjectService } from "../../project/src/index.js";
import { ChatService } from "./chat-service.js";
import { projectMessagesForCompaction } from "./compaction-service.js";
import type { LlmDebugEvent } from "./debug-events.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("session compaction", () => {
  it("stores a streamed Markdown summary and uses it in the next session", async () => {
    const directory = await createTemporaryDirectory();
    const project = await new ProjectService().create(path.join(directory, "novel.cleo"));
    await setProjectInstructions(project.root, "数据库项目规则");
    await writeFile(path.join(project.root, "AGENTS.md"), "第一版文件规则", "utf8");
    const provider = new CompactionAwareProvider();
    const chat = await ChatService.open(project.root);
    const debugEvents: LlmDebugEvent[] = [];

    try {
      const first = await chat.send({
        projectId: project.manifest.id,
        provider,
        model: "scripted",
        prompt: "主角是一名退休刑警。",
        signal: new AbortController().signal,
      });
      expect(provider.requests[0]?.messages[0]?.content).toContain("数据库项目规则");
      expect(provider.requests[0]?.messages[0]?.content).not.toContain("第一版文件规则");
      expect(provider.requests[0]?.thinking).toBeUndefined();

      await writeFile(path.join(project.root, "AGENTS.md"), "第二版文件规则", "utf8");
      await chat.compactConversation({
        conversationId: first.conversationId,
        provider,
        model: "scripted",
        trigger: "manual",
        signal: new AbortController().signal,
        onDebugEvent: (event) => debugEvents.push(event),
      });

      const compactionRequest = provider.requests.find((request) =>
        request.messages[0]?.content.includes("会话上下文压缩器"),
      );
      expect(compactionRequest?.messages[1]?.content).toContain("Markdown 摘要正文");
      expect(compactionRequest?.messages[1]?.content).not.toContain("输出 JSON Schema");
      expect(compactionRequest?.responseFormat).toBeUndefined();
      expect(compactionRequest?.thinking).toEqual({ type: "disabled" });
      expect(compactionRequest?.maxTokens).toBeUndefined();
      expect(compactionRequest?.tools).toEqual([]);

      const payload = extractCompactionPayload(compactionRequest!.messages[1]!.content);
      expect(payload.summaryTargetTokens).toBe(8_000);
      expect(payload.messages).toEqual([
        { role: "user", content: "主角是一名退休刑警。" },
        { role: "assistant", content: "已记录主角职业。" },
      ]);
      for (const message of payload.messages as Array<Record<string, unknown>>) {
        expect(Object.keys(message).sort()).toEqual(["content", "role"]);
      }
      expect(provider.compactionChunks).toBeGreaterThan(1);
      expect(debugEvents).toContainEqual(
        expect.objectContaining({
          type: "llm-assembled-output",
          operation: "compaction",
          content: provider.summary,
          characterCount: provider.summary.length,
          finishReason: "stop",
        }),
      );

      const sessions = chat.getSessions(first.conversationId);
      expect(sessions.map((session) => session.status)).toEqual(["closed", "active"]);
      expect(chat.getProjectInstructions()?.content).toBe("数据库项目规则");
      expect(chat.getSessionDetails(first.conversationId, 1).summary?.summary).toBe(
        provider.summary,
      );

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
          !request.messages[0]?.content.includes("会话上下文压缩器") &&
          request.messages.some((message) => message.content === "请找回主角的职业。"),
      );
      expect(postCompaction?.messages[0]?.content).toContain("数据库项目规则");
      expect(postCompaction?.messages[0]?.content).not.toContain("第二版文件规则");
      expect(postCompaction?.messages[0]?.content).toContain("<session_handoff");
      expect(postCompaction?.messages[0]?.content).toContain(provider.summary);
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

  it("keeps the old session active and logs an empty assembled result before validation", async () => {
    const directory = await createTemporaryDirectory();
    const project = await new ProjectService().create(path.join(directory, "novel.cleo"));
    const provider = new EmptyCompactionProvider();
    const chat = await ChatService.open(project.root);
    const debugEvents: LlmDebugEvent[] = [];

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
          onDebugEvent: (event) => debugEvents.push(event),
        }),
      ).rejects.toMatchObject({ code: "COMPACTION_EMPTY_SUMMARY" });

      expect(chat.getSessions(first.conversationId)).toEqual([
        expect.objectContaining({ status: "active", compactionRequired: true }),
      ]);
      expect(
        chat.getConversationHistory(first.conversationId).map((message) => message.content),
      ).toEqual(expect.arrayContaining(["保留这一条历史。", "已记录。"]));
      expect(provider.requests).toHaveLength(2);
      expect(debugEvents).toContainEqual(
        expect.objectContaining({
          type: "llm-assembled-output",
          operation: "compaction",
          content: "   ",
          characterCount: 3,
        }),
      );
      expect(debugEvents).toContainEqual(
        expect.objectContaining({
          type: "llm-response-error",
          operation: "compaction",
          errorCode: "COMPACTION_EMPTY_SUMMARY",
        }),
      );
    } finally {
      await chat.close();
    }
  });

  it("chains inherited summaries across consecutive compactions and injects only the current one", async () => {
    const directory = await createTemporaryDirectory();
    const project = await new ProjectService().create(path.join(directory, "novel.cleo"));
    await setProjectInstructions(project.root, "连续压缩项目规则");
    const provider = new CumulativeCompactionProvider();
    const chat = await ChatService.open(project.root);

    try {
      const first = await chat.send({
        projectId: project.manifest.id,
        provider,
        model: "scripted",
        prompt: "第一阶段决定。",
        signal: new AbortController().signal,
      });
      await chat.compactConversation({
        conversationId: first.conversationId,
        provider,
        model: "scripted",
        signal: new AbortController().signal,
      });

      const afterFirst = chat.getSessions(first.conversationId);
      const summary1 = chat.getSessionDetails(first.conversationId, 1).summary;
      expect(summary1).not.toBeNull();
      expect(afterFirst).toHaveLength(2);
      expect(afterFirst[0]).toMatchObject({
        ordinal: 1,
        status: "closed",
        inheritedSummaryId: null,
      });
      expect(afterFirst[1]).toMatchObject({
        ordinal: 2,
        status: "active",
        inheritedSummaryId: summary1!.id,
      });

      await chat.send({
        conversationId: first.conversationId,
        projectId: project.manifest.id,
        provider,
        model: "scripted",
        prompt: "第二阶段决定。",
        signal: new AbortController().signal,
      });
      await chat.compactConversation({
        conversationId: first.conversationId,
        provider,
        model: "scripted",
        signal: new AbortController().signal,
      });

      const sessions = chat.getSessions(first.conversationId);
      const summary2 = chat.getSessionDetails(first.conversationId, 2).summary;
      expect(summary2).not.toBeNull();
      expect(sessions).toHaveLength(3);
      expect(sessions.map((session) => session.status)).toEqual(["closed", "closed", "active"]);
      expect(sessions[0]?.inheritedSummaryId).toBeNull();
      expect(sessions[1]?.inheritedSummaryId).toBe(summary1!.id);
      expect(sessions[2]?.inheritedSummaryId).toBe(summary2!.id);
      expect(provider.compactionPayloads[0]?.previousSummary).toBeNull();
      expect(provider.compactionPayloads[1]?.previousSummary).toBe(summary1!.summary);
      expect(provider.compactionPayloads[1]?.messages).toEqual([
        { role: "user", content: "第二阶段决定。" },
        { role: "assistant", content: "已完成普通回答 2。" },
      ]);

      await chat.send({
        conversationId: first.conversationId,
        projectId: project.manifest.id,
        provider,
        model: "scripted",
        prompt: "检查第三个 Session。",
        signal: new AbortController().signal,
      });
      const thirdSessionRequest = provider.requests.find((request) =>
        request.messages.some((message) => message.content === "检查第三个 Session。"),
      );
      const systemContext = thirdSessionRequest?.messages[0]?.content ?? "";
      expect(systemContext).toContain(summary2!.summary);
      expect(systemContext).not.toContain(summary1!.summary);
      expect(systemContext.indexOf("<cleo_core_instructions>")).toBeLessThan(
        systemContext.indexOf("<project_instructions"),
      );
      expect(systemContext.indexOf("<project_instructions")).toBeLessThan(
        systemContext.indexOf("<session_handoff"),
      );
    } finally {
      await chat.close();
    }
  });

  it("uses map-reduce Markdown compaction when one request cannot hold the session", async () => {
    const directory = await createTemporaryDirectory();
    const project = await new ProjectService().create(path.join(directory, "novel.cleo"));
    const provider = new HierarchicalCompactionProvider();
    const chat = await ChatService.open(project.root);
    const debugEvents: LlmDebugEvent[] = [];

    try {
      const first = await chat.send({
        projectId: project.manifest.id,
        provider,
        model: "scripted",
        prompt: "关键线索".repeat(3_000),
        signal: new AbortController().signal,
      });
      await chat.compactConversation({
        conversationId: first.conversationId,
        provider,
        model: "scripted",
        contextWindowTokens: 20_000,
        signal: new AbortController().signal,
        onDebugEvent: (event) => debugEvents.push(event),
      });

      expect(provider.compactionCalls).toBeGreaterThan(1);
      expect(chat.getSessions(first.conversationId).map((session) => session.status)).toEqual([
        "closed",
        "active",
      ]);
      expect(debugEvents).toContainEqual(
        expect.objectContaining({ type: "llm-assembled-output", operation: "compaction-segment" }),
      );
      expect(debugEvents).toContainEqual(
        expect.objectContaining({ type: "llm-assembled-output", operation: "compaction-reduce" }),
      );
      expect(chat.getSessionDetails(first.conversationId, 1).summary?.summary).toBe(
        "# 当前成果\n\n已完成所有分段摘要的归并。",
      );
      const raw = new DatabaseSync(path.join(project.root, ".cleo", "project.sqlite"));
      try {
        const mappings = raw
          .prepare(
            `SELECT mapping.phase, calls.status
             FROM compaction_job_model_call_mapping mapping
             JOIN model_calls calls ON calls.id = mapping.model_call_id
             ORDER BY mapping.ordinal`,
          )
          .all() as Array<{ phase: string; status: string }>;
        expect(mappings).toHaveLength(provider.compactionCalls);
        expect(mappings.map((mapping) => mapping.phase)).toEqual(
          expect.arrayContaining(["segment", "reduce"]),
        );
        expect(mappings.every((mapping) => mapping.status === "completed")).toBe(true);
        const job = raw
          .prepare("SELECT orchestration_config_json FROM compaction_jobs LIMIT 1")
          .get() as { orchestration_config_json: string };
        expect(JSON.parse(job.orchestration_config_json)).toMatchObject({
          algorithmVersion: "session-compaction-v7-map-reduce",
          contextWindowTokens: 20_000,
        });
      } finally {
        raw.close();
      }
    } finally {
      await chat.close();
    }
  });

  it("projects messages explicitly so future reasoning fields cannot enter compaction", () => {
    const message = {
      id: "message-1",
      conversationId: "conversation-1",
      sessionId: "session-1",
      sequence: 1,
      createdAt: "2026-08-02T00:00:00.000Z",
      role: "assistant",
      content: "可以交接的正文",
      reasoningContent: "绝不能发送的思考内容",
    } as StoredMessage & { reasoningContent: string };

    const projected = projectMessagesForCompaction([message]);
    expect(projected).toEqual([{ role: "assistant", content: "可以交接的正文" }]);
    expect(JSON.stringify(projected)).not.toContain("绝不能发送的思考内容");
  });
});

class CompactionAwareProvider implements ModelProvider {
  readonly id = "compaction-script";
  readonly displayName = "Compaction Script";
  readonly requests: ModelRequest[] = [];
  readonly summary = "# 当前目标\n\n继续创作小说。\n\n# 已确认决定\n\n- 主角是一名退休刑警。";
  compactionChunks = 0;
  private normalCalls = 0;

  async validateConfiguration(): Promise<ProviderHealth> {
    return { ok: true, message: "ready" };
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    if (request.messages[0]?.content.includes("会话上下文压缩器")) {
      const firstBoundary = Math.floor(this.summary.length / 3);
      const secondBoundary = Math.floor((this.summary.length * 2) / 3);
      for (const text of [
        this.summary.slice(0, firstBoundary),
        this.summary.slice(firstBoundary, secondBoundary),
        this.summary.slice(secondBoundary),
      ]) {
        this.compactionChunks += 1;
        yield { type: "text-delta", text };
      }
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

class EmptyCompactionProvider implements ModelProvider {
  readonly id = "empty-script";
  readonly displayName = "Empty Script";
  readonly requests: ModelRequest[] = [];

  async validateConfiguration(): Promise<ProviderHealth> {
    return { ok: true, message: "ready" };
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    const rawOutput = request.messages[0]?.content.includes("会话上下文压缩器")
      ? "   "
      : "已记录。";
    request.onProtocolEvent?.({
      type: "request",
      method: "POST",
      url: "https://provider.test/chat/completions",
      headers: { Authorization: "<redacted>" },
      body: JSON.stringify(request),
    });
    request.onProtocolEvent?.({
      type: "response-head",
      status: 200,
      statusText: "OK",
      headers: { "content-type": "text/event-stream" },
    });
    request.onProtocolEvent?.({ type: "response-chunk", chunk: rawOutput });
    yield { type: "text-delta", text: rawOutput };
    yield { type: "done", finishReason: "stop" };
  }
}

class CumulativeCompactionProvider implements ModelProvider {
  readonly id = "cumulative-script";
  readonly displayName = "Cumulative Script";
  readonly requests: ModelRequest[] = [];
  readonly compactionPayloads: Record<string, unknown>[] = [];
  private normalCalls = 0;

  async validateConfiguration(): Promise<ProviderHealth> {
    return { ok: true, message: "ready" };
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    if (request.messages[0]?.content.includes("会话上下文压缩器")) {
      const payload = extractCompactionPayload(request.messages[1]!.content);
      this.compactionPayloads.push(payload);
      const summaryNumber = this.compactionPayloads.length;
      yield {
        type: "text-delta",
        text: `# 当前成果\n\n累计摘要标记 ${summaryNumber}。`,
      };
      yield { type: "done", finishReason: "stop" };
      return;
    }

    this.normalCalls += 1;
    yield { type: "text-delta", text: `已完成普通回答 ${this.normalCalls}。` };
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
    if (!request.messages[0]?.content.includes("会话上下文压缩器")) {
      yield { type: "text-delta", text: "已记录长线索。" };
      yield { type: "done", finishReason: "stop" };
      return;
    }

    this.compactionCalls += 1;
    const payload = extractCompactionPayload(request.messages[1]!.content);
    const isReduce = Array.isArray(payload.segmentSummaries);
    yield {
      type: "text-delta",
      text: isReduce
        ? "# 当前成果\n\n已完成所有分段摘要的归并。"
        : "# 当前成果\n\n已压缩本段关键线索。",
    };
    yield { type: "done", finishReason: "stop" };
  }
}

function extractCompactionPayload(content: string): Record<string, unknown> {
  const prefix = "输入 JSON：\n";
  const suffix = "\n\n请只返回 Markdown 会话摘要正文。";
  const start = content.lastIndexOf(prefix);
  const end = content.lastIndexOf(suffix);
  if (start < 0 || end < 0 || end <= start) throw new Error("Compaction payload not found");
  return JSON.parse(content.slice(start + prefix.length, end)) as Record<string, unknown>;
}

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "cleodoc-session-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function setProjectInstructions(projectRoot: string, content: string): Promise<void> {
  const database = await ProjectDatabase.open(projectRoot);
  try {
    await new ProjectInstructionRepository(database).set(content, 0);
  } finally {
    await database.close();
  }
}
