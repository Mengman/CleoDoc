import path from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, ipcMain, Menu } from "electron";

import {
  desktopChannels,
  desktopRuntimeInfoSchema,
  showWindowMenuInputSchema,
} from "../shared/desktop-api.js";
import { createWindowMenuTemplate } from "./window-menu-template.js";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

function registerDesktopIpc(): void {
  ipcMain.handle(desktopChannels.getRuntimeInfo, () =>
    desktopRuntimeInfoSchema.parse({
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron,
      nodeVersion: process.versions.node,
      platform: process.platform,
    }),
  );

  ipcMain.handle(desktopChannels.showWindowMenu, (event, rawInput: unknown) => {
    const input = showWindowMenuInputSchema.parse(rawInput);
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window === null) throw new Error("找不到请求窗口菜单的 CleoDoc 窗口。");

    Menu.buildFromTemplate(
      createWindowMenuTemplate(input.menuId, process.env.ELECTRON_RENDERER_URL !== undefined),
    ).popup({
      window,
      x: input.x,
      y: input.y,
    });
  });
}

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

app.whenReady().then(() => {
  app.setAppUserModelId("org.cleodoc.desktop");
  Menu.setApplicationMenu(null);
  registerDesktopIpc();
  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
