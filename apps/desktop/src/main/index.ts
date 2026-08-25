import path from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, dialog, Menu, nativeTheme, safeStorage } from "electron";

import {
  AppStateService,
  getSoftwareUserConfigPath,
  initializeSoftwareConfig,
  type AppThemePreference,
} from "../../../../packages/config/src/index.js";
import { DesktopCredentialStore } from "./desktop-credential-store.js";
import { ProviderService } from "../../../../packages/model-providers/src/index.js";
import { createDesktopChatServiceOptions, DesktopChatService } from "./desktop-chat-service.js";
import { DesktopLlmSettingsService } from "./desktop-llm-settings.js";
import { DesktopProjectRuntime, toDesktopOperationError } from "./desktop-project-runtime.js";
import { createDesktopMaterialServiceOptions } from "./desktop-material-service-options.js";
import { resolveDesktopDefaultConfigPath } from "./desktop-resource-paths.js";
import { registerDesktopIpc } from "./desktop-ipc.js";
import { desktopChannels, type DesktopTheme } from "../shared/desktop-api.js";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

function resolveDesktopTheme(preference: AppThemePreference): DesktopTheme {
  return preference === "system"
    ? nativeTheme.shouldUseDarkColors
      ? "dark"
      : "light"
    : preference;
}

function createMainWindow(theme: DesktopTheme): BrowserWindow {
  // Create and load the hardened primary CleoDoc window.
  // 1. Configure the native window and disable renderer Node.js access.
  // 2. Block new windows and renderer-driven navigation.
  // 3. Load the development renderer or the packaged local HTML entry.
  const window = new BrowserWindow({
    width: 1600,
    height: 960,
    minWidth: 1120,
    minHeight: 720,
    show: false,
    title: "CleoDoc",
    backgroundColor: theme === "dark" ? "#0b111a" : "#f5f7fb",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    ...(process.platform === "darwin"
      ? {}
      : {
          titleBarOverlay: {
            color: theme === "dark" ? "#121822" : "#f5f7fb",
            symbolColor: theme === "dark" ? "#d8deea" : "#1e293b",
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
  // Initialize the desktop process, restore project state, and manage application shutdown.
  // 1. Load software configuration and construct the single project runtime.
  // 2. Restore the remembered project before registering IPC and creating the window.
  // 3. Handle window recreation and release project resources before application exit.
  await app.whenReady();
  app.setAppUserModelId("org.cleodoc.desktop");
  Menu.setApplicationMenu(null);

  const defaultConfigPath = resolveDesktopDefaultConfigPath({
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    isPackaged: app.isPackaged,
  });
  const loadedConfig = await initializeSoftwareConfig({ defaultConfigPath });
  const appStateService = new AppStateService();
  const appState = await appStateService.read();
  let currentTheme = resolveDesktopTheme(appState.themePreference);
  const credentialStore = new DesktopCredentialStore(
    path.join(path.dirname(getSoftwareUserConfigPath()), "credentials", "openai-compatible.bin"),
    {
      isAvailable: async () => {
        // Reject Electron's insecure Linux plaintext fallback.
        const available = await safeStorage.isAsyncEncryptionAvailable();
        return (
          available &&
          (process.platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text")
        );
      },
      encrypt: (plainText) => safeStorage.encryptStringAsync(plainText),
      decrypt: (encrypted) => safeStorage.decryptStringAsync(encrypted),
    },
  );
  const providerService = new ProviderService({ credentials: credentialStore });
  const projectRuntime = new DesktopProjectRuntime({
    appStateService,
    busyTimeoutMs: loadedConfig.config.database.busyTimeoutMs,
    chat: createDesktopChatServiceOptions(),
    materials: createDesktopMaterialServiceOptions(
      loadedConfig.config,
      path.resolve(path.dirname(defaultConfigPath), ".."),
    ),
    provider: providerService,
  });
  const llmSettings = new DesktopLlmSettingsService(providerService);
  const desktopChat = new DesktopChatService(projectRuntime);
  let restoreError: { code: string; message: string } | undefined;
  try {
    await projectRuntime.restorePreviousProject();
  } catch (error) {
    restoreError = toDesktopOperationError(error);
  }

  let mainWindow: BrowserWindow | null = null;
  const openMainWindow = (): BrowserWindow => {
    // Create the only main window and clear its reference after native destruction.
    const window = createMainWindow(currentTheme);
    mainWindow = window;
    window.once("closed", () => {
      if (mainWindow === window) mainWindow = null;
    });
    return window;
  };

  registerDesktopIpc(
    projectRuntime,
    llmSettings,
    desktopChat,
    () => mainWindow,
    () => currentTheme,
  );
  const window = openMainWindow();
  nativeTheme.on("updated", () => {
    // Follow operating-system changes while the saved preference remains System.
    if (appState.themePreference !== "system") return;
    currentTheme = resolveDesktopTheme(appState.themePreference);
    if (mainWindow === null || mainWindow.isDestroyed()) return;
    mainWindow.setBackgroundColor(currentTheme === "dark" ? "#0b111a" : "#f5f7fb");
    mainWindow.webContents.send(desktopChannels.themeChanged, { theme: currentTheme });
  });
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
    if (mainWindow === null) openMainWindow();
  });

  let projectClosedForExit = false;
  app.on("before-quit", (event) => {
    // Delay the first quit request until all project-scoped resources are released.
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
