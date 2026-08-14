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
import { ProjectService } from "../../project/src/index.js";
import { TEST_CHAT_OPTIONS, TEST_DATABASE_OPTIONS } from "../../../test/runtime-options.js";
import { MutableModelMessageSender } from "../../../test/model-sender.js";
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
  it("keeps partial cancelled output out of history and resumes after reopening", async () => {
    const project = await createProject();
    const provider = new MutableModelMessageSender(
      new CancelAfterFirstChunkProvider(),
      "recovery-model",
    );
    let chat = await ChatService.open(project.root, TEST_CHAT_OPTIONS, { provider });
    const controller = new AbortController();
    let conversationId: string;
    try {
      const cancelledError = await chat
        .send({
          projectId: project.manifest.id,
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
      expect(conversationId).not.toBe("");
      expect(chat.getConversationHistory(conversationId)).toEqual([
        expect.objectContaining({ role: "user", content: "生成一段随后取消的正文" }),
      ]);

      await chat.close();
      provider.use(new RecoveryProvider(), "recovery-model");
      chat = await ChatService.open(project.root, TEST_CHAT_OPTIONS, { provider });
      const resumed = await chat.send({
        conversationId,
        projectId: project.manifest.id,
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

  it("stops a looping tool provider and allows a later turn to recover", async () => {
    const project = await createProject();
    const provider = new MutableModelMessageSender(new LoopingToolProvider(), "loop-model");
    const chat = await ChatService.open(
      project.root,
      { ...TEST_CHAT_OPTIONS, maxToolRounds: 2 },
      { provider },
    );
    let conversationId: string;
    try {
      const loopError = await chat
        .send({
          projectId: project.manifest.id,
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

      provider.use(new LoopRecoveryProvider(), "loop-model");
      const recovered = await chat.send({
        conversationId,
        projectId: project.manifest.id,
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
