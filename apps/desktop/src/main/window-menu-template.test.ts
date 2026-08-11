import { describe, expect, it } from "vitest";

import { createWindowMenuTemplate } from "./window-menu-template.js";

describe("createWindowMenuTemplate", () => {
  it("keeps unavailable project actions disabled", () => {
    expect(createWindowMenuTemplate("file", false).slice(0, 2)).toEqual([
      { label: "打开项目…", enabled: false },
      { label: "新建项目…", enabled: false },
    ]);
  });

  it("only exposes developer tools in development mode", () => {
    expect(createWindowMenuTemplate("view", false)).not.toContainEqual({
      label: "开发者工具",
      role: "toggleDevTools",
    });
    expect(createWindowMenuTemplate("view", true)).toContainEqual({
      label: "开发者工具",
      role: "toggleDevTools",
    });
  });
});
