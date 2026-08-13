import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AppStateService,
  initializeSoftwareConfig,
} from "../../../../packages/config/src/index.js";
import type { ModelEvent, ModelMessageSender } from "../../../../packages/contracts/src/index.js";
import { ProjectService } from "../../../../packages/project/src/index.js";
import { TEST_CHAT_OPTIONS, TEST_DATABASE_OPTIONS } from "../../../../test/runtime-options.js";
import type { DesktopChatMessageEvent } from "../shared/desktop-api.js";
import { DesktopChatService } from "./desktop-chat-service.js";
import { DesktopProjectRuntime } from "./desktop-project-runtime.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("DesktopChatService", () => {
  it("continues a project conversation and emits only desktop chat events", async () => {
    // Verify the desktop use case returns only this turn instead of reloading recent history.
    const fixture = await createFixture();
    const initial = await fixture.runtime.runChatTask(({ projectId, signal, chat }) =>
      chat.send({
        projectId,
        provider: new ScriptedSender("初始回答"),
        model: "deepseek-v4-flash",
        prompt: "开始对话",
        signal,
      }),
    );
    const events: DesktopChatMessageEvent[] = [];

    const result = await new DesktopChatService(
      fixture.runtime,
      new ScriptedSender("最终回答", "先思考"),
    ).send(
      {
        requestId: "8e564f20-70ec-4a3d-b820-54299948635d",
        conversationId: initial.conversationId,
        prompt: "继续对话",
      },
      (event) => events.push(event),
    );

    expect(events.map((event) => event.type)).toEqual([
      "reasoning-delta",
      "reasoning-complete",
      "content-delta",
    ]);
    expect(result.conversation.id).toBe(initial.conversationId);
    expect(result.messages.map(({ role, content }) => ({ role, content }))).toEqual([
      { role: "user", content: "继续对话" },
      { role: "assistant", content: "最终回答" },
    ]);
    await fixture.runtime.dispose();
  });
});

class ScriptedSender implements ModelMessageSender {
  readonly id = "openai-compatible";
  readonly displayName = "OpenAI-compatible";

  constructor(
    private readonly content: string,
    private readonly reasoning?: string,
  ) {}

  async *send(): AsyncIterable<ModelEvent> {
    if (this.reasoning !== undefined) yield { type: "reasoning-delta", text: this.reasoning };
    yield { type: "text-delta", text: this.content };
    yield { type: "done", finishReason: "stop" };
  }
}

async function createFixture(): Promise<{
  readonly runtime: DesktopProjectRuntime;
}> {
  // Create one open project with isolated application and database state.
  const root = await mkdtemp(path.join(tmpdir(), "cleodoc-desktop-chat-"));
  temporaryDirectories.push(root);
  await initializeSoftwareConfig({
    environment: { CLEODOC_HOME: path.join(root, "config") },
    defaultConfigPath: path.resolve("resources/config/software-default.yaml"),
  });
  const appStateService = new AppStateService({
    CLEODOC_HOME: path.join(root, "home"),
  });
  const runtime = new DesktopProjectRuntime({
    busyTimeoutMs: TEST_DATABASE_OPTIONS.busyTimeoutMs,
    appStateService,
    chat: TEST_CHAT_OPTIONS,
  });
  const project = await new ProjectService(TEST_DATABASE_OPTIONS).create(
    path.join(root, "chat.cleo"),
  );
  await runtime.open(project.root);
  return { runtime };
}
