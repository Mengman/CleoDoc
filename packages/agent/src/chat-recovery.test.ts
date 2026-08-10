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
import { DocumentService, ProjectService } from "../../project/src/index.js";
import { TEST_CHAT_OPTIONS, TEST_DATABASE_OPTIONS } from "../../../test/runtime-options.js";
import { ChatService } from "./chat-service.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("ChatService failure recovery", () => {
  it("keeps a cancelled turn unsavable and resumes the same conversation after reopening", async () => {
    const project = await createProject();
    let chat = await ChatService.open(project.root, TEST_CHAT_OPTIONS);
    const controller = new AbortController();
    let conversationId: string;
    let cancelledGenerationId: string;
    try {
      const cancelledError = await chat
        .send({
          projectId: project.manifest.id,
          provider: new CancelAfterFirstChunkProvider(),
          model: "recovery-model",
          prompt: "生成一段随后取消的正文",
          signal: controller.signal,
          onEvent: (event) => {
            if (event.type === "text-delta") controller.abort();
          },
        })
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(cancelledError).toMatchObject({ code: "GENERATION_CANCELLED" });
      if (!(cancelledError instanceof AppError)) throw new Error("Expected AppError.");
      conversationId = String(cancelledError.details?.conversationId ?? "");
      cancelledGenerationId = String(cancelledError.details?.generationId ?? "");
      expect(conversationId).not.toBe("");
      expect(cancelledGenerationId).not.toBe("");
      await expect(
        chat.saveGeneration("manuscript/cancelled.md", { generationId: cancelledGenerationId }),
      ).rejects.toMatchObject({ code: "GENERATION_NOT_FOUND" });
      expect(await new DocumentService(project.root).list()).toEqual([]);
      expect(chat.getConversationHistory(conversationId)).toEqual([
        expect.objectContaining({ role: "user", content: "生成一段随后取消的正文" }),
      ]);

      await chat.close();
      chat = await ChatService.open(project.root, TEST_CHAT_OPTIONS);
      const resumed = await chat.send({
        conversationId,
        projectId: project.manifest.id,
        provider: new RecoveryProvider(),
        model: "recovery-model",
        prompt: "取消后继续正常交流",
        signal: new AbortController().signal,
      });
      expect(resumed.conversationId).toBe(conversationId);
      expect(resumed.content).toBe("已经从取消状态恢复。");
      expect(chat.getConversationHistory(conversationId).map((message) => message.content)).toEqual(
        ["生成一段随后取消的正文", "取消后继续正常交流", "已经从取消状态恢复。"],
      );
    } finally {
      await chat.close();
    }
  });

  it("does not overwrite a saved chapter without an explicit overwrite decision", async () => {
    const project = await createProject();
    const chat = await ChatService.open(project.root, TEST_CHAT_OPTIONS);
    const provider = new SequentialTextProvider(["# 第二章\n\n初稿。\n", "# 第二章\n\n修订稿。\n"]);
    try {
      const first = await chat.send({
        projectId: project.manifest.id,
        provider,
        model: "sequential-model",
        prompt: "生成初稿",
        signal: new AbortController().signal,
      });
      await chat.saveGeneration("manuscript/chapter-002.md", { generationId: first.generationId });

      const second = await chat.send({
        conversationId: first.conversationId,
        projectId: project.manifest.id,
        provider,
        model: "sequential-model",
        prompt: "生成修订稿",
        signal: new AbortController().signal,
      });
      await expect(
        chat.saveGeneration("manuscript/chapter-002.md", { generationId: second.generationId }),
      ).rejects.toMatchObject({ code: "DOCUMENT_ALREADY_EXISTS" });
      const documents = new DocumentService(project.root);
      expect((await documents.read("manuscript/chapter-002.md")).content).toBe(first.content);

      await chat.saveGeneration("manuscript/chapter-002.md", {
        generationId: second.generationId,
        overwrite: true,
      });
      expect((await documents.read("manuscript/chapter-002.md")).content).toBe(second.content);
    } finally {
      await chat.close();
    }
  });

  it("stops a looping tool provider and allows a later turn to recover", async () => {
    const project = await createProject();
    const chat = await ChatService.open(project.root, { ...TEST_CHAT_OPTIONS, maxToolRounds: 2 });
    let conversationId: string;
    try {
      const loopError = await chat
        .send({
          projectId: project.manifest.id,
          provider: new LoopingToolProvider(),
          model: "loop-model",
          prompt: "不要无限调用工具",
          signal: new AbortController().signal,
        })
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(loopError).toMatchObject({
        code: "PROVIDER_UNAVAILABLE",
        message: "模型连续调用工具超过 2 轮。",
      });
      if (!(loopError instanceof AppError)) throw new Error("Expected AppError.");
      conversationId = String(loopError.details?.conversationId ?? "");
      expect(conversationId).not.toBe("");
      expect(
        chat.getConversationHistory(conversationId).filter((message) => message.role === "tool"),
      ).toHaveLength(2);

      const recovered = await chat.send({
        conversationId,
        projectId: project.manifest.id,
        provider: new LoopRecoveryProvider(),
        model: "loop-model",
        prompt: "停止调用工具并直接回答",
        signal: new AbortController().signal,
      });
      expect(recovered.content).toBe("已经停止工具循环。");
      expect(recovered.conversationId).toBe(conversationId);
    } finally {
      await chat.close();
    }
  });
});

class CancelAfterFirstChunkProvider implements ModelProvider {
  readonly id = "recoverable-provider";
  readonly displayName = "Cancellable Provider";

  async validateConfiguration(): Promise<ProviderHealth> {
    return { ok: true, message: "ready" };
  }

  async *stream(_request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    yield { type: "text-delta", text: "不应进入正式历史的部分内容" };
    if (signal.aborted) throw new AppError("GENERATION_CANCELLED", "生成已取消。");
    yield { type: "done", finishReason: "stop" };
  }
}

class RecoveryProvider implements ModelProvider {
  readonly id = "recoverable-provider";
  readonly displayName = "Recovery Provider";

  async validateConfiguration(): Promise<ProviderHealth> {
    return { ok: true, message: "ready" };
  }

  async *stream(): AsyncIterable<ModelEvent> {
    yield { type: "text-delta", text: "已经从取消状态恢复。" };
    yield { type: "done", finishReason: "stop" };
  }
}

class SequentialTextProvider implements ModelProvider {
  readonly id = "sequential-provider";
  readonly displayName = "Sequential Provider";
  private callCount = 0;

  constructor(private readonly responses: readonly string[]) {}

  async validateConfiguration(): Promise<ProviderHealth> {
    return { ok: true, message: "ready" };
  }

  async *stream(): AsyncIterable<ModelEvent> {
    const response = this.responses[this.callCount++] ?? "";
    yield { type: "text-delta", text: response };
    yield { type: "done", finishReason: "stop" };
  }
}

class LoopingToolProvider implements ModelProvider {
  readonly id = "loop-provider";
  readonly displayName = "Looping Tool Provider";
  private callCount = 0;

  async validateConfiguration(): Promise<ProviderHealth> {
    return { ok: true, message: "ready" };
  }

  async *stream(): AsyncIterable<ModelEvent> {
    this.callCount += 1;
    yield {
      type: "tool-call",
      call: {
        id: `list-documents-${this.callCount}`,
        name: "list_project_documents",
        argumentsJson: "{}",
      },
    };
    yield { type: "done", finishReason: "tool_calls" };
  }
}

class LoopRecoveryProvider implements ModelProvider {
  readonly id = "loop-provider";
  readonly displayName = "Loop Recovery Provider";

  async validateConfiguration(): Promise<ProviderHealth> {
    return { ok: true, message: "ready" };
  }

  async *stream(): AsyncIterable<ModelEvent> {
    yield { type: "text-delta", text: "已经停止工具循环。" };
    yield { type: "done", finishReason: "stop" };
  }
}

async function createProject() {
  const directory = await mkdtemp(path.join(tmpdir(), "cleodoc-chat-recovery-test-"));
  temporaryDirectories.push(directory);
  return await new ProjectService(TEST_DATABASE_OPTIONS).create(path.join(directory, "novel.cleo"));
}
