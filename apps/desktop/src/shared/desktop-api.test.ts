import { describe, expect, it } from "vitest";

import { desktopRuntimeInfoSchema, showWindowMenuInputSchema } from "./desktop-api.js";

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
