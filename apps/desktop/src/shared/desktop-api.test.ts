import { describe, expect, it } from "vitest";

import {
  desktopProjectOperationResultSchema,
  desktopProjectStateSchema,
  desktopRuntimeInfoSchema,
  showWindowMenuInputSchema,
} from "./desktop-api.js";

describe("desktopRuntimeInfoSchema", () => {
  it("accepts the public desktop runtime projection", () => {
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
  it("accepts only the public project summary", () => {
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
    expect(() =>
      desktopProjectStateSchema.parse({
        ...state,
        project: { ...state.project, root: "D:/private-project" },
      }),
    ).toThrow();
  });

  it("rejects error payloads containing internal details", () => {
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
