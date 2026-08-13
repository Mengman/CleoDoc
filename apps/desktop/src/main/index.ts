import path from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, dialog, Menu } from "electron";

import { initializeSoftwareConfig } from "../../../../packages/config/src/index.js";
import { DesktopProjectRuntime, toDesktopOperationError } from "./desktop-project-runtime.js";
import { resolveDesktopDefaultConfigPath } from "./desktop-resource-paths.js";
import { registerDesktopIpc } from "./desktop-ipc.js";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1600,
    height: 960,
    minWidth: 1120,
    minHeight: 720,
    show: false,
    title: "CleoDoc",
    backgroundColor: "#0b111a",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    ...(process.platform === "darwin"
      ? {}
      : {
          titleBarOverlay: {
            color: "#121822",
            symbolColor: "#d8deea",
            height: 40,
          },
        }),
    webPreferences: {
      preload: path.join(currentDirectory, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.once("ready-to-show", () => window.show());
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());

  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (rendererUrl === undefined) {
    void window.loadFile(path.join(currentDirectory, "../renderer/index.html"));
  } else {
    void window.loadURL(rendererUrl);
  }

  return window;
}

async function startDesktop(): Promise<void> {
  await app.whenReady();
  app.setAppUserModelId("org.cleodoc.desktop");
  Menu.setApplicationMenu(null);

  const loadedConfig = await initializeSoftwareConfig({
    defaultConfigPath: resolveDesktopDefaultConfigPath({
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath,
      isPackaged: app.isPackaged,
    }),
  });
  const projectRuntime = new DesktopProjectRuntime({
    busyTimeoutMs: loadedConfig.config.database.busyTimeoutMs,
  });
  let restoreError: { code: string; message: string } | undefined;
  try {
    await projectRuntime.restorePreviousProject();
  } catch (error) {
    restoreError = toDesktopOperationError(error);
  }

  registerDesktopIpc(projectRuntime);
  const window = createMainWindow();
  if (restoreError !== undefined) {
    window.once("ready-to-show", () => {
      void dialog.showMessageBox(window, {
        type: "warning",
        title: "未能恢复上次项目",
        message: restoreError.message,
      });
    });
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });

  let projectClosedForExit = false;
  app.on("before-quit", (event) => {
    if (projectClosedForExit) return;
    event.preventDefault();
    void projectRuntime.dispose().finally(() => {
      projectClosedForExit = true;
      app.quit();
    });
  });
}

void startDesktop().catch((error: unknown) => {
  const safeError = toDesktopOperationError(error);
  dialog.showErrorBox("CleoDoc 启动失败", safeError.message);
  app.exit(1);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
