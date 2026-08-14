import { describe, expect, it } from "vitest";

import {
  desktopProjectOperationResultSchema,
  desktopProjectStateSchema,
  desktopRuntimeInfoSchema,
  desktopLlmApiSettingsSchema,
  desktopConversationHistoryResultSchema,
  desktopChatMessageEventSchema,
  manuscriptListResultSchema,
  manuscriptDocumentsChangedEventSchema,
  manuscriptPathSchema,
  manuscriptReadResultSchema,
  materialListResultSchema,
  saveDesktopLlmApiSettingsInputSchema,
  sendDesktopChatMessageInputSchema,
  sendDesktopChatMessageResultSchema,
  showWindowMenuInputSchema,
} from "./desktop-api.js";

describe("desktopRuntimeInfoSchema", () => {
  // Verify the runtime information allowed to cross the desktop IPC boundary.
  // 1. Accept the intended public Electron and platform fields.
  // 2. Reject additional fields that could expose private desktop state.
  it("accepts the public desktop runtime projection", () => {
    // Verify the exact public runtime projection accepted by the schema.
    expect(
      desktopRuntimeInfoSchema.parse({
        appVersion: "0.1.0",
        electronVersion: "43.1.0",
        nodeVersion: "24.18.1",
        platform: "win32",
      }),
    ).toEqual({
      appVersion: "0.1.0",
      electronVersion: "43.1.0",
      nodeVersion: "24.18.1",
      platform: "win32",
    });
  });

  it("rejects unexpected IPC fields", () => {
    // Verify that strict parsing rejects an accidental project-path disclosure.
    expect(() =>
      desktopRuntimeInfoSchema.parse({
        appVersion: "0.1.0",
        electronVersion: "43.1.0",
        nodeVersion: "24.18.1",
        platform: "win32",
        projectRoot: "D:/private-project",
      }),
    ).toThrow();
  });
});

describe("desktopProjectStateSchema", () => {
  // Verify project-state and operation-error contracts exposed to the renderer.
  // 1. Accept the safe project summary while rejecting private project fields.
  // 2. Reject error payloads that contain stack traces or internal details.
  it("accepts only the public project summary", () => {
    // Verify that an open state accepts only the documented project summary fields.
    const state = desktopProjectStateSchema.parse({
      status: "open",
      project: {
        id: "9e564f20-70ec-4a3d-b820-54299948635d",
        name: "灯塔失语者",
        language: "zh-CN",
        documentCount: 12,
        database: "ok",
      },
    });

    expect(state.status).toBe("open");
    if (state.status !== "open") throw new Error("expected an open project state");
    expect(() => {
      return desktopProjectStateSchema.parse({
        ...state,
        project: { ...state.project, root: "D:/private-project" },
      });
    }).toThrow();
  });

  it("rejects error payloads containing internal details", () => {
    // Verify that the public error contract excludes stack traces and other extra fields.
    expect(() =>
      desktopProjectOperationResultSchema.parse({
        outcome: "error",
        state: { status: "closed" },
        error: {
          code: "PROJECT_NOT_FOUND",
          message: "项目不存在。",
          stack: "internal stack",
        },
      }),
    ).toThrow();
  });
});

describe("desktop manuscript document schemas", () => {
  it("exposes only portable read-only manuscript data", () => {
    // Verify the complete renderer contract for listing and reading manuscript files.
    // 1. Accept a portable Markdown/TXT path and a flat plain-text response.
    // 2. Reject document wrappers and generated document identifiers.
    // 3. Reject absolute, traversing, or unsupported manuscript paths in responses.
    const relativePath = "manuscript/第一卷/第一章.md";
    expect(
      manuscriptListResultSchema.parse({
        outcome: "success",
        documents: [relativePath],
      }),
    ).toMatchObject({ outcome: "success", documents: [relativePath] });
    expect(
      manuscriptReadResultSchema.parse({
        outcome: "success",
        relativePath,
        content: "# 第一章\n",
      }),
    ).toMatchObject({ outcome: "success", content: "# 第一章\n" });
    expect(
      manuscriptDocumentsChangedEventSchema.parse({
        outcome: "success",
        documents: [relativePath],
      }),
    ).toEqual({ outcome: "success", documents: [relativePath] });

    expect(() =>
      manuscriptListResultSchema.parse({
        outcome: "success",
        documents: [{ relativePath, id: "doc_0123456789abcdef" }],
      }),
    ).toThrow();
    expect(() => manuscriptPathSchema.parse("doc_0123456789abcdef")).toThrow();
    for (const relativePath of [
      "D:/private/第一章.md",
      "manuscript/../第一章.md",
      "manuscript/第一章.json",
    ]) {
      expect(() =>
        manuscriptListResultSchema.parse({
          outcome: "success",
          documents: [relativePath],
        }),
      ).toThrow();
    }
  });
});

describe("desktop material list schema", () => {
  it("exposes imported material titles without internal metadata", () => {
    // Verify the renderer receives only the titles required by the current list UI.
    expect(
      materialListResultSchema.parse({
        outcome: "success",
        materials: ["人物名册", "港口资料"],
      }),
    ).toEqual({ outcome: "success", materials: ["人物名册", "港口资料"] });
    expect(() =>
      materialListResultSchema.parse({
        outcome: "success",
        materials: [{ title: "人物名册", relativePath: "materials/private.json" }],
      }),
    ).toThrow();
  });
});

describe("showWindowMenuInputSchema", () => {
  // Verify that native menu requests accept only known menus and bounded coordinates.
  it("accepts a bounded menu request", () => {
    expect(showWindowMenuInputSchema.parse({ menuId: "view", x: 144, y: 40 })).toEqual({
      menuId: "view",
      x: 144,
      y: 40,
    });
  });

  it("rejects unknown menus and unbounded coordinates", () => {
    expect(() => showWindowMenuInputSchema.parse({ menuId: "developer", x: -1, y: 40 })).toThrow();
  });
});

describe("saveDesktopLlmApiSettingsInputSchema", () => {
  it("accepts only the temporary DeepSeek catalog model", () => {
    // Verify the desktop boundary cannot select an undeclared model during the transition.
    expect(
      saveDesktopLlmApiSettingsInputSchema.parse({
        baseUrl: "https://api.deepseek.com/v1",
        modelName: "deepseek-v4-flash",
        apiKey: "sk-private",
      }),
    ).toMatchObject({ modelName: "deepseek-v4-flash" });
    expect(() =>
      saveDesktopLlmApiSettingsInputSchema.parse({
        baseUrl: "https://api.deepseek.com/v1",
        modelName: "unknown-model",
      }),
    ).toThrow();
  });
});

describe("desktopLlmApiSettingsSchema", () => {
  it("exposes only API key status and length", () => {
    // Verify the settings response can size its mask without returning secret content.
    expect(
      desktopLlmApiSettingsSchema.parse({
        baseUrl: "https://api.deepseek.com",
        modelName: "deepseek-v4-flash",
        apiKeyConfigured: true,
        apiKeyLength: 32,
        secureStorageAvailable: true,
      }),
    ).toMatchObject({ apiKeyConfigured: true, apiKeyLength: 32 });
    expect(() =>
      desktopLlmApiSettingsSchema.parse({
        baseUrl: "https://api.deepseek.com",
        modelName: "deepseek-v4-flash",
        apiKeyConfigured: true,
        apiKeyLength: 32,
        apiKey: "sk-private",
        secureStorageAvailable: true,
      }),
    ).toThrow();
  });
});

describe("desktopConversationHistoryResultSchema", () => {
  it("accepts visible history fields and rejects internal message identifiers", () => {
    // Verify desktop history exposes reasoning but no session, model-call, or row identifiers.
    const message = {
      id: "9e564f20-70ec-4a3d-b820-54299948635d",
      role: "assistant" as const,
      content: "回答",
      reasoningContent: "思考过程",
      sequence: 8,
      createdAt: "2026-08-13T12:00:00.000Z",
    };
    expect(
      desktopConversationHistoryResultSchema.parse({
        outcome: "success",
        conversation: { id: "7e564f20-70ec-4a3d-b820-54299948635d", title: "章节讨论" },
        messages: [message],
      }),
    ).toMatchObject({ outcome: "success", messages: [message] });
    expect(() =>
      desktopConversationHistoryResultSchema.parse({
        outcome: "success",
        conversation: { id: "7e564f20-70ec-4a3d-b820-54299948635d", title: "章节讨论" },
        messages: [{ ...message, sessionId: "private-session" }],
      }),
    ).toThrow();
  });
});

describe("sendDesktopChatMessageInputSchema", () => {
  it("requires an existing conversation and request correlation identifier", () => {
    // Verify the current desktop boundary permits continuation but not conversation creation.
    expect(
      sendDesktopChatMessageInputSchema.parse({
        requestId: "8e564f20-70ec-4a3d-b820-54299948635d",
        conversationId: "7e564f20-70ec-4a3d-b820-54299948635d",
        prompt: "继续对话",
      }),
    ).toMatchObject({ conversationId: "7e564f20-70ec-4a3d-b820-54299948635d" });
    expect(() =>
      sendDesktopChatMessageInputSchema.parse({
        requestId: "8e564f20-70ec-4a3d-b820-54299948635d",
        prompt: "创建对话",
      }),
    ).toThrow();
  });
});

describe("sendDesktopChatMessageResultSchema", () => {
  it("returns exactly the persisted user and assistant messages for the completed turn", () => {
    // Verify a send result is incremental and cannot be confused with a history page.
    const identity = {
      conversation: { id: "7e564f20-70ec-4a3d-b820-54299948635d", title: "章节讨论" },
    };
    const messages = [
      {
        id: "8e564f20-70ec-4a3d-b820-54299948635d",
        role: "user",
        content: "继续写",
        sequence: 20,
        createdAt: "2026-08-13T12:00:00.000Z",
      },
      {
        id: "9e564f20-70ec-4a3d-b820-54299948635d",
        role: "assistant",
        content: "回答",
        reasoningContent: "思考",
        sequence: 21,
        createdAt: "2026-08-13T12:00:01.000Z",
      },
    ];

    expect(
      sendDesktopChatMessageResultSchema.parse({ outcome: "success", ...identity, messages }),
    ).toMatchObject({ outcome: "success", messages });
    expect(() =>
      sendDesktopChatMessageResultSchema.parse({
        outcome: "success",
        ...identity,
        messages: [...messages, messages[0]],
      }),
    ).toThrow();
  });
});

describe("desktopChatMessageEventSchema", () => {
  it("accepts only correlated reasoning and content stream events", () => {
    // Verify streaming IPC cannot expose usage, Tool calls, or other internal model events.
    const identity = {
      requestId: "8e564f20-70ec-4a3d-b820-54299948635d",
      conversationId: "7e564f20-70ec-4a3d-b820-54299948635d",
    };
    expect(
      desktopChatMessageEventSchema.parse({
        type: "reasoning-delta",
        ...identity,
        text: "分析",
      }),
    ).toMatchObject({ type: "reasoning-delta", text: "分析" });
    expect(
      desktopChatMessageEventSchema.parse({ type: "reasoning-complete", ...identity }),
    ).toMatchObject({ type: "reasoning-complete" });
    expect(() =>
      desktopChatMessageEventSchema.parse({ type: "tool-call", ...identity, name: "secret" }),
    ).toThrow();
  });
});
