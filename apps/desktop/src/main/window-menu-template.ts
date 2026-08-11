import type { MenuItemConstructorOptions } from "electron";

import type { WindowMenuId } from "../shared/desktop-api.js";

export function createWindowMenuTemplate(
  menuId: WindowMenuId,
  isDevelopment: boolean,
): MenuItemConstructorOptions[] {
  switch (menuId) {
    case "file":
      return [
        { label: "打开项目…", enabled: false },
        { label: "新建项目…", enabled: false },
        { type: "separator" },
        { label: "退出 CleoDoc", role: "quit" },
      ];
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
