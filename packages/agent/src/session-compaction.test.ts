import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import type {
  ModelEvent,
  ModelProvider,
  ProviderModelRequest,
  ProviderHealth,
  StoredMessage,
} from "../../contracts/src/index.js";
import {
  ProjectDatabase,
  ProjectInstructionRepository,
  SessionRepository,
} from "../../database/src/index.js";
import { DocumentService, ProjectService } from "../../project/src/index.js";
import { ChatService } from "./chat-service.js";
import {
  TEST_CHAT_OPTIONS,
  TEST_CONTEXT_POLICY,
  TEST_DATABASE_OPTIONS,
} from "../../../test/runtime-options.js";
import { senderForProvider } from "../../../test/model-sender.js";
import {
  projectMessagesForCompaction,
  segmentMessagesForCompaction,
} from "./compaction-service.js";
import type { LlmDebugEvent } from "./debug-events.js";
import { ProjectToolCatalog, ProjectToolRuntime } from "./tool/index.js";

const temporaryDirectories: string[] = [];
const TEST_20K_CONTEXT_POLICY = {
  ...TEST_CONTEXT_POLICY,
  contextWindowTokens: 20_000,
  reservedOutputTokens: 7_680,
  nextUserInputReserveTokens: 1_000,
};

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
    const project = await new ProjectService(TEST_DATABASE_OPTIONS).create(
      path.join(directory, "novel.cleo"),
    );
    await setProjectInstructions(project.root, "数据库项目规则");
    await writeFile(path.join(project.root, "AGENTS.md"), "第一版文件规则", "utf8");
    const provider = senderForProvider(new CompactionAwareProvider());
    const chat = await ChatService.open(project.root, TEST_CHAT_OPTIONS, { provider });
    const debugEvents: LlmDebugEvent[] = [];

    try {
      const first = await chat.send({
        projectId: project.manifest.id,
        prompt: "主角是一名退休刑警。",
        signal: new AbortController().signal,
      });
      expect(provider.requests[0]?.messages[0]?.content).toContain("数据库项目规则");
      expect(provider.requests[0]?.messages[0]?.content).not.toContain("第一版文件规则");
      expect(provider.requests[0]?.thinking).toEqual({ type: "disabled" });

      await writeFile(path.join(project.root, "AGENTS.md"), "第二版文件规则", "utf8");
      await chat.compactConversation({
        conversationId: first.conversationId,
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
      expect(postCompaction?.messages[0]?.content).not.toContain("sha256=");
      expect(postCompaction?.messages[0]?.content).toContain("<session_summary");
      expect(postCompaction?.messages[0]?.content).not.toContain("source_session_id=");
      expect(postCompaction?.messages[0]?.content).not.toContain("summary_id=");
      expect(postCompaction?.messages[0]?.content).not.toContain("<session_handoff");
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
    const project = await new ProjectService(TEST_DATABASE_OPTIONS).create(
      path.join(directory, "novel.cleo"),
    );
    const provider = senderForProvider(new EmptyCompactionProvider());
    const chat = await ChatService.open(project.root, TEST_CHAT_OPTIONS, { provider });
    const debugEvents: LlmDebugEvent[] = [];

    try {
      const first = await chat.send({
        projectId: project.manifest.id,
        prompt: "保留这一条历史。",
        signal: new AbortController().signal,
      });
      await expect(
        chat.compactConversation({
          conversationId: first.conversationId,
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
    const project = await new ProjectService(TEST_DATABASE_OPTIONS).create(
      path.join(directory, "novel.cleo"),
    );
    await setProjectInstructions(project.root, "连续压缩项目规则");
    const provider = senderForProvider(new CumulativeCompactionProvider());
    const chat = await ChatService.open(project.root, TEST_CHAT_OPTIONS, { provider });

    try {
      const first = await chat.send({
        projectId: project.manifest.id,
        prompt: "第一阶段决定。",
        signal: new AbortController().signal,
      });
      await chat.compactConversation({
        conversationId: first.conversationId,
        signal: new AbortController().signal,
      });

      const afterFirst = chat.getSessions(first.conversationId);
      const summary1 = chat.getSessionDetails(first.conversationId, 1).summary;
      expect(summary1).not.toBeNull();
      expect(afterFirst).toHaveLength(2);
      expect(afterFirst[0]).toMatchObject({
        ordinal: 1,
        status: "closed",
        inheritedCompactionJobId: null,
      });
      expect(afterFirst[1]).toMatchObject({
        ordinal: 2,
        status: "active",
        inheritedCompactionJobId: summary1!.id,
      });

      await chat.send({
        conversationId: first.conversationId,
        projectId: project.manifest.id,
        prompt: "第二阶段决定。",
        signal: new AbortController().signal,
      });
      await chat.compactConversation({
        conversationId: first.conversationId,
        signal: new AbortController().signal,
      });

      const sessions = chat.getSessions(first.conversationId);
      const summary2 = chat.getSessionDetails(first.conversationId, 2).summary;
      expect(summary2).not.toBeNull();
      expect(sessions).toHaveLength(3);
      expect(sessions.map((session) => session.status)).toEqual(["closed", "closed", "active"]);
      expect(sessions[0]?.inheritedCompactionJobId).toBeNull();
      expect(sessions[1]?.inheritedCompactionJobId).toBe(summary1!.id);
      expect(sessions[2]?.inheritedCompactionJobId).toBe(summary2!.id);
      expect(provider.compactionPayloads[0]?.previousSummary).toBeNull();
      expect(provider.compactionPayloads[1]?.previousSummary).toBe(summary1!.summary);
      expect(provider.compactionPayloads[1]?.messages).toEqual([
        { role: "user", content: "第二阶段决定。" },
        { role: "assistant", content: "已完成普通回答 2。" },
      ]);

      await chat.send({
        conversationId: first.conversationId,
        projectId: project.manifest.id,
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
        systemContext.indexOf("<session_summary"),
      );
    } finally {
      await chat.close();
    }
  });

  it("uses map-reduce Markdown compaction when one request cannot hold the session", async () => {
    const directory = await createTemporaryDirectory();
    const project = await new ProjectService(TEST_DATABASE_OPTIONS).create(
      path.join(directory, "novel.cleo"),
    );
    const provider = senderForProvider(new HierarchicalCompactionProvider(), "scripted", {
      contextWindowTokens: TEST_20K_CONTEXT_POLICY.contextWindowTokens,
      maxOutputTokens: TEST_20K_CONTEXT_POLICY.reservedOutputTokens,
      reasoningSupported: true,
      reasoningEfforts: ["low", "medium", "high"],
    });
    const smallContextOptions = {
      ...TEST_CHAT_OPTIONS,
      context: {
        ...TEST_CHAT_OPTIONS.context,
        nextUserInputReserveTokens: TEST_20K_CONTEXT_POLICY.nextUserInputReserveTokens,
        nextUserInputReserveRatio:
          TEST_20K_CONTEXT_POLICY.nextUserInputReserveTokens /
          TEST_20K_CONTEXT_POLICY.contextWindowTokens,
      },
    };
    const chat = await ChatService.open(project.root, smallContextOptions, { provider });
    const debugEvents: LlmDebugEvent[] = [];

    try {
      const first = await chat.send({
        projectId: project.manifest.id,
        prompt: "关键线索".repeat(3_000),
        signal: new AbortController().signal,
      });
      await chat.compactConversation({
        conversationId: first.conversationId,
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
          algorithmVersion: "session-compaction-v8-turn-segmentation",
          contextWindowTokens: 20_000,
          segmentPayloadTargetRatio: 0.8,
        });
      } finally {
        raw.close();
      }
    } finally {
      await chat.close();
    }
  });

  it("segments oversized sessions on complete user turns and keeps tool protocols atomic", () => {
    const messages = [
      storedMessage({ sequence: 1, role: "user", content: `turn-1-user ${"A".repeat(1_200)}` }),
      storedMessage({
        sequence: 2,
        role: "assistant",
        content: `turn-1-assistant ${"B".repeat(1_200)}`,
      }),
      storedMessage({ sequence: 3, role: "user", content: `turn-2-user ${"C".repeat(1_200)}` }),
      storedMessage({
        sequence: 4,
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "read-document-1",
            name: "read_project_document",
            argumentsJson: JSON.stringify({ relativePath: "materials/source.md" }),
          },
        ],
      }),
      storedMessage({
        sequence: 5,
        role: "tool",
        name: "read_project_document",
        toolCallId: "read-document-1",
        content: JSON.stringify({
          ok: true,
          relativePath: "materials/source.md",
          content: "RAW_DOCUMENT_CONTENT".repeat(4_000),
          contentHash: "hash-1",
          offset: 0,
          nextOffset: null,
          totalCharacters: 80_000,
          truncated: false,
        }),
      }),
      storedMessage({
        sequence: 6,
        role: "assistant",
        content: `turn-2-assistant ${"D".repeat(1_200)}`,
      }),
      storedMessage({ sequence: 7, role: "user", content: `turn-3-user ${"E".repeat(1_200)}` }),
      storedMessage({
        sequence: 8,
        role: "assistant",
        content: `turn-3-assistant ${"F".repeat(1_200)}`,
      }),
    ];

    const segments = segmentMessagesForCompaction(messages, 1_600, 512, 0.8, 0.6);
    const segmentBySequence = new Map<number, number>();
    segments.forEach((segment, segmentIndex) => {
      for (const message of segment) segmentBySequence.set(message.sequence, segmentIndex);
    });

    expect(segments.length).toBeGreaterThan(1);
    expect(segmentBySequence.get(1)).toBe(segmentBySequence.get(2));
    expect(segmentBySequence.get(3)).toBe(segmentBySequence.get(4));
    expect(segmentBySequence.get(4)).toBe(segmentBySequence.get(5));
    expect(segmentBySequence.get(5)).toBe(segmentBySequence.get(6));
    expect(segmentBySequence.get(7)).toBe(segmentBySequence.get(8));
    expect(segments.flatMap((segment) => segment.map((message) => message.sequence))).toEqual(
      messages.map((message) => message.sequence),
    );
  });

  it("splits one oversized text message on Unicode-safe semantic boundaries without data loss", () => {
    const content = "第一段🙂仍需保留。\n\n第二段继续讨论！\n".repeat(1_000);
    const segments = segmentMessagesForCompaction(
      [storedMessage({ sequence: 1, role: "user", content })],
      1_000,
      512,
      0.8,
      0.6,
    );
    const fragments = segments.flatMap((segment) => segment.map((message) => message.content));

    expect(fragments.length).toBeGreaterThan(1);
    expect(fragments.join("")).toBe(content);
    for (const fragment of fragments) {
      expect(fragment).not.toMatch(/[\uD800-\uDBFF]$/u);
      expect(fragment).not.toMatch(/^[\uDC00-\uDFFF]/u);
    }
  });

  it("rejects an oversized atomic tool protocol instead of splitting calls from results", () => {
    const toolCalls = Array.from({ length: 300 }, (_, index) => ({
      id: `call-${index}`,
      name: "unknown_tool",
      argumentsJson: JSON.stringify({ secret: `argument-${index}` }),
    }));
    const messages = [
      storedMessage({ sequence: 1, role: "user", content: "执行一组工具调用。" }),
      storedMessage({ sequence: 2, role: "assistant", content: "", toolCalls }),
      ...toolCalls.map((call, index) =>
        storedMessage({
          sequence: index + 3,
          role: "tool",
          name: call.name,
          toolCallId: call.id,
          content: JSON.stringify({ ok: true, secret: `result-${index}` }),
        }),
      ),
    ];

    expect(() => segmentMessagesForCompaction(messages, 2_000, 512, 0.8, 0.6)).toThrowError(
      expect.objectContaining({
        code: "PROVIDER_CONTEXT_LIMIT",
        message: expect.stringContaining("Tool Call"),
      }),
    );
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

  it("projects tool results through each Tool contract without leaking retrieved content", async () => {
    const directory = await createTemporaryDirectory();
    const project = await new ProjectService(TEST_DATABASE_OPTIONS).create(
      path.join(directory, "novel.cleo"),
    );
    const database = await ProjectDatabase.open(project.root, TEST_DATABASE_OPTIONS);
    const catalog = ProjectToolCatalog.create({
      documents: new DocumentService(project.root),
      history: new SessionRepository(database),
      projectInstructions: new ProjectInstructionRepository(database),
    });
    const runtime = new ProjectToolRuntime(
      { projectId: project.manifest.id, conversationId: "conversation-1" },
      catalog,
    );
    const assistant = storedMessage({
      sequence: 1,
      role: "assistant",
      content: "准备调用工具。",
      toolCalls: [
        {
          id: "write-1",
          name: "write_project_document",
          argumentsJson: JSON.stringify({
            path: "manuscript/summary.md",
            content: "WRITE_ARGUMENT_SECRET",
          }),
        },
        {
          id: "write-failed",
          name: "write_project_document",
          argumentsJson: JSON.stringify({
            path: "manuscript/existing.md",
            content: "FAILED_WRITE_ARGUMENT_SECRET",
          }),
        },
        {
          id: "read-doc-1",
          name: "read_project_document",
          argumentsJson: JSON.stringify({ document: "manuscript/chapter.md", offset: 0 }),
        },
        {
          id: "read-doc-v1",
          name: "read_project_document",
          argumentsJson: JSON.stringify({ document: "manuscript/legacy.md", offset: 0 }),
        },
        {
          id: "search-history-1",
          name: "search_conversation_history",
          argumentsJson: JSON.stringify({ query: "HISTORY_QUERY_SECRET", limit: 5 }),
        },
        {
          id: "read-history-1",
          name: "read_conversation_message",
          argumentsJson: JSON.stringify({
            messageId: "old-message",
            maxCharacters: 2_000,
          }),
        },
        {
          id: "read-instructions-1",
          name: "read_project_instructions",
          argumentsJson: "{}",
        },
        { id: "unknown-1", name: "future_tool", argumentsJson: '{"secret":"ARG_SECRET"}' },
      ],
    });
    const messages = [
      assistant,
      storedMessage({
        sequence: 2,
        role: "tool",
        name: "write_project_document",
        toolCallId: "write-1",
        content: JSON.stringify({
          ok: true,
          tool: { name: "write_project_document", version: 2 },
          data: {
            path: "manuscript/summary.md",
            size: 10,
            updatedAt: "2026-08-03T00:00:00.000Z",
            created: true,
          },
        }),
      }),
      storedMessage({
        sequence: 3,
        role: "tool",
        name: "write_project_document",
        toolCallId: "write-failed",
        content: JSON.stringify({
          ok: false,
          tool: { name: "write_project_document", version: 2 },
          error: {
            code: "DOCUMENT_ALREADY_EXISTS",
            message: "ERROR_MESSAGE_SECRET",
          },
        }),
      }),
      storedMessage({
        sequence: 4,
        role: "tool",
        name: "read_project_document",
        toolCallId: "read-doc-1",
        content: JSON.stringify({
          ok: true,
          tool: { name: "read_project_document", version: 2 },
          data: {
            path: "manuscript/chapter.md",
            updatedAt: "2026-08-03T00:00:00.000Z",
            offset: 0,
            content: "DOCUMENT_CONTENT_SECRET",
            truncated: false,
            nextOffset: null,
            totalCharacters: 100,
          },
        }),
      }),
      storedMessage({
        sequence: 5,
        role: "tool",
        name: "search_conversation_history",
        toolCallId: "search-history-1",
        content: JSON.stringify({
          ok: true,
          tool: { name: "search_conversation_history", version: 1 },
          data: {
            results: [
              {
                excerpt: "HISTORY_EXCERPT_SECRET",
                messageId: "old-message",
                role: "user",
                createdAt: "2026-08-03T00:00:00.000Z",
              },
            ],
          },
        }),
      }),
      storedMessage({
        sequence: 6,
        role: "tool",
        name: "read_conversation_message",
        toolCallId: "read-history-1",
        content: JSON.stringify({
          ok: true,
          tool: { name: "read_conversation_message", version: 2 },
          data: {
            messageId: "old-message",
            role: "user",
            createdAt: "2026-08-03T00:00:00.000Z",
            content: "HISTORY_MESSAGE_SECRET",
            offset: 0,
            truncated: false,
            nextOffset: null,
            totalCharacters: 22,
          },
        }),
      }),
      storedMessage({
        sequence: 7,
        role: "tool",
        name: "read_project_instructions",
        toolCallId: "read-instructions-1",
        content: JSON.stringify({
          ok: true,
          tool: { name: "read_project_instructions", version: 1 },
          data: {
            content: "PROJECT_INSTRUCTIONS_SECRET",
            updatedAt: "2026-08-03T00:00:00.000Z",
          },
        }),
      }),
      storedMessage({
        sequence: 8,
        role: "tool",
        name: "read_project_document",
        toolCallId: "read-doc-v1",
        content: JSON.stringify({
          ok: true,
          tool: { name: "read_project_document", version: 1 },
          data: {
            document: {
              path: "manuscript/legacy.md",
              content: "LEGACY_DOCUMENT_CONTENT_SECRET",
            },
          },
        }),
      }),
      storedMessage({
        sequence: 9,
        role: "tool",
        name: "future_tool",
        toolCallId: "unknown-1",
        content: "UNKNOWN_TOOL_RESULT_SECRET",
      }),
    ];

    try {
      const projected = runtime.projectToolEventsForCompaction(messages);
      expect(projected).toEqual([
        expect.objectContaining({
          tool: { name: "write_project_document", version: 2 },
          operation: "document_created",
          status: "completed",
          path: "manuscript/summary.md",
        }),
        expect.objectContaining({
          tool: { name: "write_project_document", version: 2 },
          status: "failed",
          errorCode: "DOCUMENT_ALREADY_EXISTS",
        }),
        expect.objectContaining({
          tool: { name: "read_project_document", version: 2 },
          path: "manuscript/chapter.md",
          totalCharacters: 100,
          truncated: false,
        }),
        expect.objectContaining({
          tool: { name: "search_conversation_history", version: 1 },
          resultCount: 1,
        }),
        expect.objectContaining({
          tool: { name: "read_conversation_message", version: 2 },
          readCharacters: 22,
          truncated: false,
        }),
        expect.objectContaining({
          tool: { name: "read_project_instructions", version: 1 },
          updatedAt: "2026-08-03T00:00:00.000Z",
        }),
        { tool: { name: "read_project_document", version: 1 }, status: "completed" },
        { tool: { name: "future_tool", version: 0 }, status: "unknown" },
      ]);
      const serialized = JSON.stringify(projected);
      for (const secret of [
        "WRITE_ARGUMENT_SECRET",
        "FAILED_WRITE_ARGUMENT_SECRET",
        "ERROR_MESSAGE_SECRET",
        "DOCUMENT_CONTENT_SECRET",
        "HISTORY_QUERY_SECRET",
        "HISTORY_EXCERPT_SECRET",
        "HISTORY_MESSAGE_SECRET",
        "PROJECT_INSTRUCTIONS_SECRET",
        "LEGACY_DOCUMENT_CONTENT_SECRET",
        "ARG_SECRET",
        "UNKNOWN_TOOL_RESULT_SECRET",
      ]) {
        expect(serialized).not.toContain(secret);
      }
      expect(serialized).not.toContain("contentHash");
      expect(serialized).not.toContain("revision");
    } finally {
      await database.close();
    }
  });
});

class CompactionAwareProvider implements ModelProvider {
  readonly id = "compaction-script";
  readonly displayName = "Compaction Script";
  readonly requests: ProviderModelRequest[] = [];
  readonly summary = "# 当前目标\n\n继续创作小说。\n\n# 已确认决定\n\n- 主角是一名退休刑警。";
  compactionChunks = 0;
  private normalCalls = 0;

  async validateConfiguration(): Promise<ProviderHealth> {
    return { ok: true, message: "ready" };
  }

  async *stream(request: ProviderModelRequest): AsyncIterable<ModelEvent> {
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
          id: "load-history-search",
          name: "project_tool_catalog",
          argumentsJson: JSON.stringify({
            action: "get",
            name: "search_conversation_history",
          }),
        },
      };
    } else if (this.normalCalls === 3) {
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
  readonly requests: ProviderModelRequest[] = [];

  async validateConfiguration(): Promise<ProviderHealth> {
    return { ok: true, message: "ready" };
  }

  async *stream(request: ProviderModelRequest): AsyncIterable<ModelEvent> {
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
  readonly requests: ProviderModelRequest[] = [];
  readonly compactionPayloads: Record<string, unknown>[] = [];
  private normalCalls = 0;

  async validateConfiguration(): Promise<ProviderHealth> {
    return { ok: true, message: "ready" };
  }

  async *stream(request: ProviderModelRequest): AsyncIterable<ModelEvent> {
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

  async *stream(request: ProviderModelRequest): AsyncIterable<ModelEvent> {
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
  const database = await ProjectDatabase.open(projectRoot, TEST_DATABASE_OPTIONS);
  try {
    await new ProjectInstructionRepository(database).set(content, 0);
  } finally {
    await database.close();
  }
}

function storedMessage(
  input: Pick<StoredMessage, "sequence" | "role" | "content"> &
    Partial<Pick<StoredMessage, "name" | "toolCallId" | "toolCalls">>,
): StoredMessage {
  return {
    messageRowid: input.sequence,
    id: `message-${input.sequence}`,
    conversationId: "conversation-1",
    sessionId: "session-1",
    modelCallId: null,
    createdAt: "2026-08-02T00:00:00.000Z",
    ...input,
  };
}
