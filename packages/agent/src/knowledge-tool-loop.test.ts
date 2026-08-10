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
import { KnowledgeToolService, MaterialService } from "../../knowledge/src/index.js";
import { ProjectService } from "../../project/src/index.js";
import {
  createTestMaterialOptions,
  TEST_CHAT_OPTIONS,
  TEST_DATABASE_OPTIONS,
} from "../../../test/runtime-options.js";
import { ChatService } from "./chat-service.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("ChatService knowledge tool loop", () => {
  it("lists and searches project materials across multiple model rounds", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cleodoc-knowledge-loop-test-"));
    temporaryDirectories.push(root);
    const project = await new ProjectService(TEST_DATABASE_OPTIONS).create(
      path.join(root, "novel.cleo"),
    );
    const materialOptions = createTestMaterialOptions();
    const materials = await MaterialService.open(project.root, materialOptions);
    await materials.addText("夜间列车使用煤油灯照明，车站值班员负责补充燃料。", {
      title: "铁路照明资料",
    });
    await materials.close();

    const knowledge = await KnowledgeToolService.open(project.root, materialOptions);
    const chat = await ChatService.open(project.root, TEST_CHAT_OPTIONS, { knowledge });
    const provider = new KnowledgeLoopProvider();
    try {
      const result = await chat.send({
        projectId: project.manifest.id,
        provider,
        model: "knowledge-loop-model",
        prompt: "资料中夜间列车用什么照明？",
        signal: new AbortController().signal,
      });

      expect(result.content).toBe("资料显示夜间列车使用煤油灯照明。");
      expect(provider.requests).toHaveLength(3);
      expect(provider.requests[0]?.tools?.map((tool) => tool.name)).toEqual(
        expect.arrayContaining(["list_materials", "search_knowledge"]),
      );
      expect(provider.requests[0]?.messages[0]?.content).toContain("list_materials");
      expect(provider.requests[1]?.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: "tool",
            name: "list_materials",
            content: expect.stringContaining("铁路照明资料"),
          }),
        ]),
      );
      expect(provider.requests[2]?.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: "tool",
            name: "search_knowledge",
            content: expect.stringContaining("煤油灯"),
          }),
        ]),
      );
      expect(chat.getConversationHistory(result.conversationId)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: "tool", name: "list_materials" }),
          expect.objectContaining({ role: "tool", name: "search_knowledge" }),
        ]),
      );
    } finally {
      await chat.close();
      await knowledge.close();
    }
  });
});

class KnowledgeLoopProvider implements ModelProvider {
  readonly id = "knowledge-loop";
  readonly displayName = "Knowledge Loop Provider";
  readonly requests: ModelRequest[] = [];

  async validateConfiguration(): Promise<ProviderHealth> {
    return { ok: true, message: "ready" };
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    if (this.requests.length === 1) {
      yield {
        type: "tool-call",
        call: { id: "list-materials", name: "list_materials", argumentsJson: "{}" },
      };
      yield { type: "done", finishReason: "tool_calls" };
      return;
    }
    if (this.requests.length === 2) {
      yield {
        type: "tool-call",
        call: {
          id: "search-materials",
          name: "search_knowledge",
          argumentsJson: JSON.stringify({ query: "煤油灯" }),
        },
      };
      yield { type: "done", finishReason: "tool_calls" };
      return;
    }
    yield { type: "text-delta", text: "资料显示夜间列车使用煤油灯照明。" };
    yield { type: "done", finishReason: "stop" };
  }
}
