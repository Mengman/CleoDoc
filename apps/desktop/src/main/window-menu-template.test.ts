import { describe, expect, it } from "vitest";

import { createWindowMenuTemplate } from "./window-menu-template.js";

describe("createWindowMenuTemplate", () => {
  // Verify native menu composition for product actions and development-only commands.
  // 1. Check that project actions are enabled only when their callbacks exist.
  // 2. Check that developer tools follow the current desktop environment.
  it("enables the existing open-project action only when it is connected", () => {
    // Verify that the file menu reflects whether the open-project action is connected.
    const onOpenProject = (): void => undefined;

    expect(createWindowMenuTemplate("file", false)[0]).toMatchObject({
      label: "打开项目…",
      enabled: false,
    });
    expect(createWindowMenuTemplate("file", false, { onOpenProject })[0]).toMatchObject({
      label: "打开项目…",
      enabled: true,
      click: onOpenProject,
    });
    expect(createWindowMenuTemplate("file", false)[1]).toMatchObject({
      label: "新建项目…",
      enabled: false,
    });
  });

  it("only exposes developer tools in development mode", () => {
    // Verify that production menus omit the developer-tools command.
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
