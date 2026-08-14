import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import type {
  ModelEvent,
  ModelProvider,
  ModelRequest,
  ProviderHealth,
} from "../../contracts/src/index.js";
import { AppError } from "../../contracts/src/index.js";
import { FakeModelProvider } from "../../model-providers/src/index.js";
import { DocumentService, ProjectService } from "../../project/src/index.js";
import { ChatService } from "./chat-service.js";
import { TEST_CHAT_OPTIONS, TEST_DATABASE_OPTIONS } from "../../../test/runtime-options.js";
import { MutableModelMessageSender, senderForProvider } from "../../../test/model-sender.js";
import type { LlmDebugEvent } from "./debug-events.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("ChatService", () => {
  it("persists a streamed chat turn and supports continuing the conversation", async () => {
    const directory = await createTemporaryDirectory();
    const project = await new ProjectService(TEST_DATABASE_OPTIONS).create(
      path.join(directory, "novel.cleo"),
      "雨夜",
    );
    const provider = new FakeModelProvider("# 第一章\n\n雨落在没有灯的车站。\n");
    const chat = await ChatService.open(project.root, TEST_CHAT_OPTIONS, {
      provider: senderForProvider(provider),
    });
    const streamed: string[] = [];
    const debugEvents: LlmDebugEvent[] = [];

    try {
      const result = await chat.send({
        projectId: project.manifest.id,
        prompt: "写一个悬疑开场",
        signal: new AbortController().signal,
        onEvent: (event) => {
          if (event.type === "text-delta") {
            streamed.push(event.text);
          }
        },
        onDebugEvent: (event) => debugEvents.push(event),
      });

      expect(streamed.join("")).toBe(result.content);
      expect(result.userMessage).toMatchObject({
        role: "user",
        content: "写一个悬疑开场",
        conversationId: result.conversationId,
      });
      expect(result.assistantMessage).toMatchObject({
        role: "assistant",
        content: result.content,
        conversationId: result.conversationId,
      });
      expect(debugEvents).toContainEqual(
        expect.objectContaining({
          type: "llm-response",
          operation: "agent",
          round: 1,
          contextTokens: 20,
          contextSource: "provider",
        }),
      );
      const continuation = await chat.send({
        conversationId: result.conversationId,
        projectId: project.manifest.id,
        prompt: "继续",
        signal: new AbortController().signal,
      });
      expect(continuation.conversationId).toBe(result.conversationId);
    } finally {
      await chat.close();
    }
  });

  it("persists the conversation id and all prior messages when a turn times out", async () => {
    const directory = await createTemporaryDirectory();
    const project = await new ProjectService(TEST_DATABASE_OPTIONS).create(
      path.join(directory, "novel.cleo"),
    );
    const provider = new MutableModelMessageSender(
      new FakeModelProvider("第一次回答"),
      "stable-model",
    );
    const chat = await ChatService.open(project.root, TEST_CHAT_OPTIONS, { provider });
    let conversationId: string;
    try {
      const successful = await chat.send({
        projectId: project.manifest.id,
        prompt: "第一次提问",
        signal: new AbortController().signal,
      });
      conversationId = successful.conversationId;
      provider.use(new TimeoutModelProvider(), "stable-model");

      await expect(
        chat.send({
          conversationId,
          projectId: project.manifest.id,
          prompt: "超时的提问",
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({
        code: "PROVIDER_TIMEOUT",
        details: { conversationId },
      });
    } finally {
      await chat.close();
    }

    const reopened = await ChatService.open(project.root, TEST_CHAT_OPTIONS, { provider });
    try {
      const latest = reopened.getLatestConversation(project.manifest.id);
      expect(latest?.id).toBe(conversationId!);
      expect(
        reopened.getConversationHistory(conversationId!).map((message) => message.content),
      ).toEqual(expect.arrayContaining(["第一次提问", "第一次回答", "超时的提问"]));
    } finally {
      await reopened.close();
    }
  });

  it("uses the current model for each turn without binding it to the conversation", async () => {
    const directory = await createTemporaryDirectory();
    const project = await new ProjectService(TEST_DATABASE_OPTIONS).create(
      path.join(directory, "novel.cleo"),
    );
    const provider = new MutableModelMessageSender(new FakeModelProvider("模型 A"), "model-a");
    const chat = await ChatService.open(project.root, TEST_CHAT_OPTIONS, { provider });
    try {
      const first = await chat.send({
        projectId: project.manifest.id,
        prompt: "第一轮",
        signal: new AbortController().signal,
      });
      provider.use(new FakeModelProvider("模型 B"), "model-b");
      await chat.send({
        projectId: project.manifest.id,
        conversationId: first.conversationId,
        prompt: "第二轮",
        signal: new AbortController().signal,
      });

      const raw = new DatabaseSync(path.join(project.root, ".cleo", "project.sqlite"));
      try {
        expect(
          raw.prepare("SELECT model FROM model_calls ORDER BY created_at, rowid").all(),
        ).toEqual([{ model: "model-a" }, { model: "model-b" }]);
        expect(raw.prepare("PRAGMA table_info(conversations)").all()).not.toEqual(
          expect.arrayContaining([expect.objectContaining({ name: "model" })]),
        );
      } finally {
        raw.close();
      }
    } finally {
      await chat.close();
    }
  });

  it("executes an approved write tool call and returns the model's final response", async () => {
    const directory = await createTemporaryDirectory();
    const project = await new ProjectService(TEST_DATABASE_OPTIONS).create(
      path.join(directory, "novel.cleo"),
    );
    const provider = new ToolCallingModelProvider();
    const chat = await ChatService.open(project.root, TEST_CHAT_OPTIONS, {
      provider: senderForProvider(provider, "tool-model"),
    });
    const approvals: string[] = [];
    const reasoningDeltas: string[] = [];

    try {
      const result = await chat.send({
        projectId: project.manifest.id,
        prompt: "总结并保存到项目",
        signal: new AbortController().signal,
        approveToolCall: async (request) => {
          const toolInput = request.input as { path?: unknown };
          if (request.toolName === "write_project_document" && typeof toolInput.path === "string") {
            approvals.push(toolInput.path);
          }
          return "allow_once";
        },
        onEvent: (event) => {
          if (event.type === "reasoning-delta") reasoningDeltas.push(event.text);
        },
      });

      expect(result.content).toBe("总结已经保存到项目中。");
      expect(approvals).toEqual(["manuscript/summary.md"]);
      expect((await new DocumentService(project.root).read("manuscript/summary.md")).content).toBe(
        "# 会谈总结\n\n确定采用雨夜车站作为开场。\n",
      );
      for (const request of provider.requests) {
        expect(request.tools).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              name: "project_tool_catalog",
              inputSchema: expect.objectContaining({ type: "object" }),
            }),
          ]),
        );
        expect(
          request.messages.find((message) => message.role === "system")?.content,
        ).not.toContain("<tool_disclosure>");
      }
      expect(provider.requests[1]?.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: "assistant",
            reasoningContent: "需要先保存用户确认的内容。",
            toolCalls: [expect.any(Object)],
          }),
          expect.objectContaining({ role: "tool", toolCallId: "call-write-1" }),
        ]),
      );
      const history = chat.getConversationHistory(result.conversationId);
      expect(history).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: "assistant",
            reasoningContent: "需要先保存用户确认的内容。",
            modelCallId: expect.any(String),
            toolCalls: [expect.any(Object)],
          }),
          expect.objectContaining({ role: "tool", toolCallId: "call-write-1" }),
          expect.objectContaining({
            role: "assistant",
            reasoningContent: "工具执行成功，可以向用户确认。",
            modelCallId: expect.any(String),
            content: result.content,
          }),
        ]),
      );
      expect(reasoningDeltas).toEqual([
        "需要先保存用户确认的内容。",
        "工具执行成功，可以向用户确认。",
      ]);

      const raw = new DatabaseSync(path.join(project.root, ".cleo", "project.sqlite"));
      try {
        expect(
          raw.prepare("SELECT COUNT(*) AS count FROM model_calls WHERE status = 'completed'").get(),
        ).toEqual({ count: 2 });
        expect(
          raw
            .prepare("SELECT COUNT(*) AS count FROM messages WHERE model_call_id IS NOT NULL")
            .get(),
        ).toEqual({ count: 2 });
      } finally {
        raw.close();
      }
    } finally {
      await chat.close();
    }
  });

  it("injects an approved database project-instruction revision on the next tool round", async () => {
    const directory = await createTemporaryDirectory();
    const project = await new ProjectService(TEST_DATABASE_OPTIONS).create(
      path.join(directory, "novel.cleo"),
    );
    const provider = new ProjectInstructionToolProvider();
    const chat = await ChatService.open(project.root, TEST_CHAT_OPTIONS, {
      provider: senderForProvider(provider, "instruction-tool-model"),
    });
    try {
      const result = await chat.send({
        projectId: project.manifest.id,
        prompt: "把第三人称限知写入项目指令",
        signal: new AbortController().signal,
        approveToolCall: async (request) =>
          request.toolName === "set_project_instructions" ? "allow_once" : "reject",
      });
      expect(result.content).toBe("项目指令已经更新。");
      expect(chat.getProjectInstructions()).toMatchObject({
        revision: 1,
        content: "始终使用第三人称限知视角。",
      });
      expect(provider.requests[2]?.messages[0]?.content).toContain("<project_instructions>");
      expect(provider.requests[2]?.messages[0]?.content).not.toContain("revision=");
      expect(provider.requests[2]?.messages[0]?.content).toContain("始终使用第三人称限知视角。");
    } finally {
      await chat.close();
    }
  });

  it("restores a catalog get load after reopening the project", async () => {
    const directory = await createTemporaryDirectory();
    const project = await new ProjectService(TEST_DATABASE_OPTIONS).create(
      path.join(directory, "novel.cleo"),
    );
    const provider = new PersistentToolProvider();
    const sender = senderForProvider(provider, "persistent-tool-model");
    let chat = await ChatService.open(project.root, TEST_CHAT_OPTIONS, { provider: sender });
    try {
      const first = await chat.send({
        projectId: project.manifest.id,
        prompt: "加载历史搜索工具",
        signal: new AbortController().signal,
      });
      expect(first.content).toBe("历史搜索工具已经加载。");

      await chat.close();
      chat = await ChatService.open(project.root, TEST_CHAT_OPTIONS, { provider: sender });

      const second = await chat.send({
        conversationId: first.conversationId,
        projectId: project.manifest.id,
        prompt: "现在搜索旧对话",
        signal: new AbortController().signal,
      });
      expect(second.content).toBe("历史搜索已经完成。");
      expect(provider.requests[2]?.tools?.map((tool) => tool.name)).toContain(
        "search_conversation_history",
      );
      expect(chat.getConversationHistory(first.conversationId)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: "tool",
            name: "search_conversation_history",
            content: expect.stringContaining('"version":1'),
          }),
        ]),
      );
    } finally {
      await chat.close();
    }
  });
});

class ToolCallingModelProvider implements ModelProvider {
  readonly id = "tool-script";
  readonly displayName = "Tool Script Provider";
  readonly requests: ModelRequest[] = [];

  async validateConfiguration(): Promise<ProviderHealth> {
    return { ok: true, message: "ready" };
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    if (this.requests.length === 1) {
      yield { type: "reasoning-delta", text: "需要先保存用户确认的内容。" };
      yield {
        type: "tool-call",
        call: {
          id: "call-write-1",
          name: "write_project_document",
          argumentsJson: JSON.stringify({
            path: "manuscript/summary.md",
            content: "# 会谈总结\n\n确定采用雨夜车站作为开场。\n",
          }),
        },
      };
      yield { type: "done", finishReason: "tool_calls" };
      return;
    }
    yield { type: "reasoning-delta", text: "工具执行成功，可以向用户确认。" };
    yield { type: "text-delta", text: "总结已经保存到项目中。" };
    yield { type: "done", finishReason: "stop" };
  }
}

class ProjectInstructionToolProvider implements ModelProvider {
  readonly id = "instruction-tool";
  readonly displayName = "Instruction Tool Provider";
  readonly requests: ModelRequest[] = [];

  async validateConfiguration(): Promise<ProviderHealth> {
    return { ok: true, message: "ready" };
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    if (this.requests.length === 1) {
      yield {
        type: "tool-call",
        call: {
          id: "load-set-instructions",
          name: "project_tool_catalog",
          argumentsJson: JSON.stringify({
            action: "get",
            name: "set_project_instructions",
          }),
        },
      };
      yield { type: "done", finishReason: "tool_calls" };
      return;
    }
    if (this.requests.length === 2) {
      yield {
        type: "tool-call",
        call: {
          id: "set-instructions",
          name: "set_project_instructions",
          argumentsJson: JSON.stringify({
            content: "始终使用第三人称限知视角。",
          }),
        },
      };
      yield { type: "done", finishReason: "tool_calls" };
      return;
    }
    yield { type: "text-delta", text: "项目指令已经更新。" };
    yield { type: "done", finishReason: "stop" };
  }
}

class PersistentToolProvider implements ModelProvider {
  readonly id = "persistent-tool";
  readonly displayName = "Persistent Tool Provider";
  readonly requests: ModelRequest[] = [];

  async validateConfiguration(): Promise<ProviderHealth> {
    return { ok: true, message: "ready" };
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    if (this.requests.length === 1) {
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
      yield { type: "done", finishReason: "tool_calls" };
      return;
    }
    if (this.requests.length === 2) {
      yield { type: "text-delta", text: "历史搜索工具已经加载。" };
      yield { type: "done", finishReason: "stop" };
      return;
    }
    if (this.requests.length === 3) {
      yield {
        type: "tool-call",
        call: {
          id: "search-history",
          name: "search_conversation_history",
          argumentsJson: JSON.stringify({ query: "旧对话" }),
        },
      };
      yield { type: "done", finishReason: "tool_calls" };
      return;
    }
    yield { type: "text-delta", text: "历史搜索已经完成。" };
    yield { type: "done", finishReason: "stop" };
  }
}

class TimeoutModelProvider implements ModelProvider {
  readonly id = "fake";
  readonly displayName = "Timeout Provider";

  async validateConfiguration(): Promise<ProviderHealth> {
    return { ok: true, message: "ready" };
  }

  stream(): AsyncIterable<ModelEvent> {
    return {
      [Symbol.asyncIterator]() {
        return {
          next: () => Promise.reject(new AppError("PROVIDER_TIMEOUT", "模型服务请求超时。")),
        };
      },
    };
  }
}

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "cleodoc-chat-test-"));
  temporaryDirectories.push(directory);
  return directory;
}
