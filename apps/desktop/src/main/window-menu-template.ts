import type { MenuItemConstructorOptions } from "electron";

import type { WindowMenuId } from "../shared/desktop-api.js";

export interface WindowMenuActions {
  readonly onCreateProject?: () => void;
  readonly onOpenProject?: () => void;
  readonly onClearRecentProjects?: () => void;
  readonly recentProjects?: readonly RecentProjectMenuItem[];
}

export interface RecentProjectMenuItem {
  readonly label: string;
  readonly onOpen: () => void;
}

export function createWindowMenuTemplate(
  menuId: WindowMenuId,
  isDevelopment: boolean,
  actions: WindowMenuActions = {},
): MenuItemConstructorOptions[] {
  // Build the native menu template for one title-bar menu.
  // 1. Connect available product actions and keep unavailable actions disabled.
  // 2. Use native Electron roles for editing, window, and application commands.
  // 3. Expose developer tools only when the desktop application runs in development.
  switch (menuId) {
    case "file": {
      const recentProjects = actions.recentProjects ?? [];
      return [
        {
          label: "打开项目…",
          enabled: actions.onOpenProject !== undefined,
          click: actions.onOpenProject,
        },
        {
          label: "新建项目…",
          enabled: actions.onCreateProject !== undefined,
          click: actions.onCreateProject,
        },
        {
          label: "打开最近项目",
          enabled: recentProjects.length > 0,
          submenu: [
            ...recentProjects.map((project) => ({
              label: project.label,
              click: project.onOpen,
            })),
            { type: "separator" },
            {
              label: "清空列表",
              enabled: actions.onClearRecentProjects !== undefined && recentProjects.length > 0,
              click: actions.onClearRecentProjects,
            },
          ],
        },
        { type: "separator" },
        { label: "退出 CleoDoc", role: "quit" },
      ];
    }
    case "edit":
      return [
        { label: "撤销", role: "undo" },
        { label: "重做", role: "redo" },
        { type: "separator" },
        { label: "剪切", role: "cut" },
        { label: "复制", role: "copy" },
        { label: "粘贴", role: "paste" },
        { label: "全选", role: "selectAll" },
      ];
    case "view":
      return [
        { label: "重新加载", role: "reload" },
        ...(isDevelopment ? [{ label: "开发者工具", role: "toggleDevTools" as const }] : []),
        { type: "separator" },
        { label: "实际大小", role: "resetZoom" },
        { label: "放大", role: "zoomIn" },
        { label: "缩小", role: "zoomOut" },
        { type: "separator" },
        { label: "切换全屏", role: "togglefullscreen" },
      ];
    case "window":
      return [
        { label: "最小化", role: "minimize" },
        { label: "关闭窗口", role: "close" },
      ];
  }
}
