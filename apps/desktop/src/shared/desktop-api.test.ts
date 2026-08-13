import { describe, expect, it } from "vitest";

import {
  desktopProjectOperationResultSchema,
  desktopProjectStateSchema,
  desktopRuntimeInfoSchema,
  desktopLlmApiSettingsSchema,
  saveDesktopLlmApiSettingsInputSchema,
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
