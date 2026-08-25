import { describe, expect, it } from "vitest";

import { createWindowMenuTemplate } from "./window-menu-template.js";

describe("createWindowMenuTemplate", () => {
  // Verify native menu composition for product actions and development-only commands.
  // 1. Check that project actions are enabled only when their callbacks exist.
  // 2. Check that developer tools follow the current desktop environment.
  it("enables connected project actions", () => {
    // Verify that the file menu reflects whether its project actions are connected.
    const onCreateProject = (): void => undefined;
    const onOpenProject = (): void => undefined;

    expect(createWindowMenuTemplate("file", false)[0]).toMatchObject({
      label: "打开项目…",
      enabled: false,
    });
    expect(
      createWindowMenuTemplate("file", false, { onCreateProject, onOpenProject })[0],
    ).toMatchObject({
      label: "打开项目…",
      enabled: true,
      click: onOpenProject,
    });
    expect(createWindowMenuTemplate("file", false)[1]).toMatchObject({
      label: "新建项目…",
      enabled: false,
    });
    expect(createWindowMenuTemplate("file", false, { onCreateProject })[1]).toMatchObject({
      label: "新建项目…",
      enabled: true,
      click: onCreateProject,
    });
  });

  it("lists recent projects and provides the clear command", () => {
    // Verify the File submenu presents recent entries before its clear-list command.
    const onOpenRecentProject = (): void => undefined;
    const onClearRecentProjects = (): void => undefined;

    expect(
      createWindowMenuTemplate("file", false, {
        recentProjects: [{ label: "lighthouse-novel", onOpen: onOpenRecentProject }],
        onClearRecentProjects,
      })[2],
    ).toMatchObject({
      label: "打开最近项目",
      enabled: true,
      submenu: [
        { label: "lighthouse-novel", click: onOpenRecentProject },
        { type: "separator" },
        { label: "清空列表", enabled: true, click: onClearRecentProjects },
      ],
    });
    expect(createWindowMenuTemplate("file", false)[2]).toMatchObject({
      label: "打开最近项目",
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

  it("marks the selected theme and updates the preference", () => {
    // Verify that the Appearance menu shows one selected theme and sends the chosen preference.
    let selectedPreference: string | undefined;
    const template = createWindowMenuTemplate("appearance", false, {
      themePreference: "dark",
      onSetThemePreference: (preference) => {
        selectedPreference = preference;
      },
    });
    const themeMenu = template[0]?.submenu;

    expect(themeMenu).toMatchObject([
      { label: "跟随系统", type: "checkbox", checked: false },
      { label: "浅色", type: "checkbox", checked: false },
      { label: "深色", type: "checkbox", checked: true },
    ]);

    const lightThemeItem = Array.isArray(themeMenu)
      ? themeMenu.find((item) => item.label === "浅色")
      : undefined;
    lightThemeItem?.click?.(
      {} as Electron.MenuItem,
      {} as Electron.BrowserWindow,
      {} as Electron.KeyboardEvent,
    );

    expect(selectedPreference).toBe("light");
  });
});
