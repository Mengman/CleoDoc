import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

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

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("ChatService", () => {
  it("persists a streamed generation and only saves it after an explicit call", async () => {
    const directory = await createTemporaryDirectory();
    const project = await new ProjectService().create(path.join(directory, "novel.cleo"), "雨夜");
    const chat = await ChatService.open(project.root);
    const provider = new FakeModelProvider("# 第一章\n\n雨落在没有灯的车站。\n");
    const streamed: string[] = [];

    try {
      const result = await chat.send({
        projectId: project.manifest.id,
        provider,
        model: "fake-model",
        prompt: "写一个悬疑开场",
        signal: new AbortController().signal,
        onEvent: (event) => {
          if (event.type === "text-delta") {
            streamed.push(event.text);
          }
        },
      });

      expect(streamed.join("")).toBe(result.content);
      expect(await new DocumentService(project.root).list()).toHaveLength(0);

      const saved = await chat.saveGeneration("manuscript/chapter-001.md", {
        generationId: result.generationId,
      });
      expect(saved.relativePath).toBe("manuscript/chapter-001.md");
      expect((await new DocumentService(project.root).read(saved.id)).content).toBe(result.content);

      const continuation = await chat.send({
        conversationId: result.conversationId,
        projectId: project.manifest.id,
        provider,
        model: "fake-model",
        prompt: "继续",
        signal: new AbortController().signal,
      });
      expect(continuation.conversationId).toBe(result.conversationId);
    } finally {
      await chat.close();
    }
  });

  it("does not save cancelled or failed generations", async () => {
    const directory = await createTemporaryDirectory();
    const project = await new ProjectService().create(path.join(directory, "novel.cleo"));
    const chat = await ChatService.open(project.root);
    try {
      await expect(chat.saveGeneration("manuscript/empty.md")).rejects.toMatchObject({
        code: "GENERATION_NOT_FOUND",
      });
    } finally {
      await chat.close();
    }
  });

  it("persists the conversation id and all prior messages when a turn times out", async () => {
    const directory = await createTemporaryDirectory();
    const project = await new ProjectService().create(path.join(directory, "novel.cleo"));
    const chat = await ChatService.open(project.root);
    let conversationId: string;
    try {
      const successful = await chat.send({
        projectId: project.manifest.id,
        provider: new FakeModelProvider("第一次回答"),
        model: "stable-model",
        prompt: "第一次提问",
        signal: new AbortController().signal,
      });
      conversationId = successful.conversationId;

      await expect(
        chat.send({
          conversationId,
          projectId: project.manifest.id,
          provider: new TimeoutModelProvider(),
          model: "stable-model",
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

    const reopened = await ChatService.open(project.root);
    try {
      const latest = reopened.getLatestConversation(project.manifest.id, "fake", "stable-model");
      expect(latest?.id).toBe(conversationId!);
      expect(
        reopened.getConversationHistory(conversationId!).map((message) => message.content),
      ).toEqual(expect.arrayContaining(["第一次提问", "第一次回答", "超时的提问"]));
    } finally {
      await reopened.close();
    }
  });

  it("executes an approved write tool call and returns the model's final response", async () => {
    const directory = await createTemporaryDirectory();
    const project = await new ProjectService().create(path.join(directory, "novel.cleo"));
    const chat = await ChatService.open(project.root);
    const provider = new ToolCallingModelProvider();
    const approvals: string[] = [];

    try {
      const result = await chat.send({
        projectId: project.manifest.id,
        provider,
        model: "tool-model",
        prompt: "总结并保存到项目",
        signal: new AbortController().signal,
        approveToolCall: async (request) => {
          approvals.push(request.path);
          return true;
        },
      });

      expect(result.content).toBe("总结已经保存到项目中。");
      expect(approvals).toEqual(["manuscript/summary.md"]);
      expect((await new DocumentService(project.root).read("manuscript/summary.md")).content).toBe(
        "# 会谈总结\n\n确定采用雨夜车站作为开场。\n",
      );
      expect(provider.requests).toHaveLength(2);
      expect(provider.requests[1]?.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: "assistant", toolCalls: [expect.any(Object)] }),
          expect.objectContaining({ role: "tool", toolCallId: "call-write-1" }),
        ]),
      );
      expect(chat.getConversationHistory(result.conversationId)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: "assistant", toolCalls: [expect.any(Object)] }),
          expect.objectContaining({ role: "tool", toolCallId: "call-write-1" }),
          expect.objectContaining({ role: "assistant", content: result.content }),
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
    yield { type: "text-delta", text: "总结已经保存到项目中。" };
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
