import { app, BrowserWindow, dialog, ipcMain, Menu, type IpcMainInvokeEvent } from "electron";

import {
  desktopChannels,
  desktopProjectOperationResultSchema,
  desktopProjectStateSchema,
  desktopRuntimeInfoSchema,
  showWindowMenuInputSchema,
  type DesktopProjectOperationResult,
} from "../shared/desktop-api.js";
import { toDesktopOperationError } from "./desktop-project-runtime.js";
import type { DesktopProjectRuntime } from "./desktop-project-runtime.js";
import { createWindowMenuTemplate } from "./window-menu-template.js";

function broadcastProjectState(runtime: DesktopProjectRuntime): void {
  const state = desktopProjectStateSchema.parse(runtime.getState());
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(desktopChannels.projectStateChanged, state);
  }
}

function requireMainWindow(event: IpcMainInvokeEvent): BrowserWindow {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (window === null || event.senderFrame !== event.sender.mainFrame) {
    throw new Error("拒绝来自非 CleoDoc 主窗口的 IPC 请求。");
  }
  return window;
}

export async function chooseAndOpenProject(
  window: BrowserWindow,
  runtime: DesktopProjectRuntime,
): Promise<DesktopProjectOperationResult> {
  const selection = await dialog.showOpenDialog(window, {
    title: "打开 CleoDoc 项目",
    buttonLabel: "打开项目",
    properties: ["openDirectory"],
  });
  if (selection.canceled || selection.filePaths[0] === undefined) {
    return desktopProjectOperationResultSchema.parse({
      outcome: "cancelled",
      state: runtime.getState(),
    });
  }

  try {
    const state = await runtime.open(selection.filePaths[0]);
    broadcastProjectState(runtime);
    return desktopProjectOperationResultSchema.parse({ outcome: "success", state });
  } catch (error) {
    broadcastProjectState(runtime);
    return desktopProjectOperationResultSchema.parse({
      outcome: "error",
      state: runtime.getState(),
      error: toDesktopOperationError(error),
    });
  }
}

export function registerDesktopIpc(runtime: DesktopProjectRuntime): void {
  ipcMain.handle(desktopChannels.getRuntimeInfo, (event) => {
    requireMainWindow(event);
    return desktopRuntimeInfoSchema.parse({
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron,
      nodeVersion: process.versions.node,
      platform: process.platform,
    });
  });

  ipcMain.handle(desktopChannels.getProjectState, (event) => {
    requireMainWindow(event);
    return desktopProjectStateSchema.parse(runtime.getState());
  });

  ipcMain.handle(desktopChannels.chooseAndOpenProject, async (event) => {
    const window = requireMainWindow(event);
    return chooseAndOpenProject(window, runtime);
  });

  ipcMain.handle(desktopChannels.closeProject, async (event) => {
    requireMainWindow(event);
    try {
      const state = await runtime.close();
      broadcastProjectState(runtime);
      return desktopProjectOperationResultSchema.parse({ outcome: "success", state });
    } catch (error) {
      return desktopProjectOperationResultSchema.parse({
        outcome: "error",
        state: runtime.getState(),
        error: toDesktopOperationError(error),
      });
    }
  });

  ipcMain.handle(desktopChannels.showWindowMenu, (event, rawInput: unknown) => {
    const input = showWindowMenuInputSchema.parse(rawInput);
    const window = requireMainWindow(event);

    Menu.buildFromTemplate(
      createWindowMenuTemplate(input.menuId, process.env.ELECTRON_RENDERER_URL !== undefined, {
        onOpenProject: () => {
          void chooseAndOpenProject(window, runtime).then((result) => {
            if (result.outcome !== "error") return;
            void dialog.showMessageBox(window, {
              type: "error",
              title: "无法打开项目",
              message: result.error.message,
            });
          });
        },
      }),
    ).popup({ window, x: input.x, y: input.y });
  });
}
