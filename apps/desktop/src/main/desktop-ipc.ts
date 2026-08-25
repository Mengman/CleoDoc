import path from "node:path";

import { app, BrowserWindow, dialog, ipcMain, Menu, type IpcMainInvokeEvent } from "electron";

import { AppError } from "../../../../packages/contracts/src/index.js";
import {
  desktopChannels,
  desktopConversationHistoryResultSchema,
  desktopConversationCreateResultSchema,
  desktopConversationListResultSchema,
  desktopToolApprovalResultSchema,
  manuscriptListResultSchema,
  manuscriptDocumentsChangedEventSchema,
  materialListResultSchema,
  materialImportResultSchema,
  materialDeleteResultSchema,
  materialRenameResultSchema,
  materialReadResultSchema,
  materialTitleSchema,
  manuscriptPathSchema,
  manuscriptReadResultSchema,
  desktopLlmApiSettingsResultSchema,
  desktopLlmApiSettingsSchema,
  desktopProjectOperationResultSchema,
  desktopRuntimeInfoSchema,
  desktopThemeBootstrapSchema,
  desktopThemePreferenceSchema,
  desktopThemeSettingsResultSchema,
  desktopThemeSettingsSchema,
  getDesktopConversationHistoryInputSchema,
  createDesktopConversationInputSchema,
  resolveDesktopToolApprovalInputSchema,
  sendDesktopChatMessageInputSchema,
  sendDesktopChatMessageResultSchema,
  showWindowMenuInputSchema,
  saveDesktopLlmApiSettingsInputSchema,
  renameDesktopMaterialInputSchema,
  type DesktopProjectOperationResult,
  type DesktopProjectState,
  type DesktopTheme,
  type DesktopThemeSettings,
} from "../shared/desktop-api.js";
import { toDesktopOperationError } from "./desktop-project-runtime.js";
import type { DesktopProjectRuntime } from "./desktop-project-runtime.js";
import type { DesktopLlmSettingsService } from "./desktop-llm-settings.js";
import type { DesktopChatService } from "./desktop-chat-service.js";
import { createWindowMenuTemplate } from "./window-menu-template.js";

type MainWindowResolver = () => BrowserWindow | null;

export interface DesktopProjectStateTarget {
  readonly isDestroyed: () => boolean;
  readonly webContents: {
    readonly send: (channel: string, state: DesktopProjectState) => void;
  };
}

export function sendProjectState(
  target: DesktopProjectStateTarget,
  state: DesktopProjectState,
): void {
  if (target.isDestroyed()) return;
  target.webContents.send(desktopChannels.projectStateChanged, state);
}

function requireMainWindow(
  event: IpcMainInvokeEvent,
  resolveMainWindow: MainWindowResolver,
): BrowserWindow {
  // Accept IPC only from the live primary window's main frame.
  const window = BrowserWindow.fromWebContents(event.sender);
  if (
    window === null ||
    window !== resolveMainWindow() ||
    window.isDestroyed() ||
    event.senderFrame !== event.sender.mainFrame
  ) {
    throw new Error("拒绝来自非 CleoDoc 主窗口的 IPC 请求。");
  }
  return window;
}

export async function chooseAndOpenProject(
  window: BrowserWindow,
  runtime: DesktopProjectRuntime,
): Promise<DesktopProjectOperationResult> {
  // Let the user select a project and return a validated, renderer-safe result.
  // 1. Open the native directory picker and preserve the current state on cancellation.
  // 2. Ask the project runtime to close the old project and open the selected project.
  // 3. Notify only the supplied main window and convert failures into the public contract.
  const recentDirectory = await runtime.getRecentDirectory();
  const selection = await dialog.showOpenDialog(window, {
    title: "打开 CleoDoc 项目",
    buttonLabel: "打开项目",
    properties: ["openDirectory"],
    ...(recentDirectory === null ? {} : { defaultPath: recentDirectory }),
  });
  if (selection.canceled || selection.filePaths[0] === undefined) {
    return desktopProjectOperationResultSchema.parse({
      outcome: "cancelled",
      state: runtime.getState(),
    });
  }

  try {
    const state = await runtime.open(selection.filePaths[0]);
    sendProjectState(window, state);
    return desktopProjectOperationResultSchema.parse({ outcome: "success", state });
  } catch (error) {
    sendProjectState(window, runtime.getState());
    return desktopProjectOperationResultSchema.parse({
      outcome: "error",
      state: runtime.getState(),
      error: toDesktopOperationError(error),
    });
  }
}

export async function chooseAndCreateProject(
  window: BrowserWindow,
  runtime: DesktopProjectRuntime,
): Promise<DesktopProjectOperationResult> {
  // Let the user select an empty directory, create the project, and open the resulting session.
  // 1. Use the system dialog so directory selection and creation remain outside the renderer.
  // 2. Preserve the active project when the selection is cancelled or the directory is rejected.
  // 3. Publish only the new renderer-safe project state after successful creation and opening.
  const recentDirectory = await runtime.getRecentDirectory();
  const selection = await dialog.showOpenDialog(window, {
    title: "新建 CleoDoc 项目",
    buttonLabel: "在此创建项目",
    properties: ["openDirectory", "createDirectory"],
    ...(recentDirectory === null ? {} : { defaultPath: recentDirectory }),
  });
  if (selection.canceled || selection.filePaths[0] === undefined) {
    return desktopProjectOperationResultSchema.parse({
      outcome: "cancelled",
      state: runtime.getState(),
    });
  }

  try {
    const state = await runtime.create(selection.filePaths[0]);
    sendProjectState(window, state);
    return desktopProjectOperationResultSchema.parse({ outcome: "success", state });
  } catch (error) {
    const state = runtime.getState();
    sendProjectState(window, state);
    return desktopProjectOperationResultSchema.parse({
      outcome: "error",
      state,
      error: toDesktopOperationError(error),
    });
  }
}

async function chooseAndImportMaterial(window: BrowserWindow, runtime: DesktopProjectRuntime) {
  // Select one supported material file and import it into the current project.
  // 1. Let the operating system return one TXT or Markdown file, or preserve state on cancel.
  // 2. Import only through the current project runtime and return its renderer-safe result.
  // 3. Present failures in a native dialog so the existing material list remains visible.
  const recentDirectory = await runtime.getRecentDirectory();
  const selection = await dialog.showOpenDialog(window, {
    title: "导入创作资料",
    buttonLabel: "导入资料",
    properties: ["openFile"],
    filters: [{ name: "文本与 Markdown", extensions: ["txt", "md", "markdown"] }],
    ...(recentDirectory === null ? {} : { defaultPath: recentDirectory }),
  });
  if (selection.canceled || selection.filePaths[0] === undefined) {
    return materialImportResultSchema.parse({ outcome: "cancelled" });
  }
  try {
    const materialPath = selection.filePaths[0];
    const result = await runtime.importMaterial(materialPath);
    await runtime.setRecentDirectory(path.dirname(materialPath));
    if (result.embeddingFailure !== null) {
      await dialog.showMessageBox(window, {
        type: "warning",
        title: "资料已导入，但 Embedding 未完成",
        message: "资料已保存，但暂时无法生成 Embedding。",
        detail: result.embeddingFailure.message,
      });
    }
    return materialImportResultSchema.parse({
      outcome: "success",
      material: {
        title: result.imported.source.title,
        inputEncoding: result.imported.inputEncoding,
        created: result.imported.created,
      },
    });
  } catch (error) {
    const safeError = toDesktopOperationError(error);
    await dialog.showMessageBox(window, {
      type: "error",
      title: "无法导入资料",
      message: safeError.message,
    });
    return materialImportResultSchema.parse({
      outcome: "error",
      error: safeError,
    });
  }
}

async function openRecentProject(
  window: BrowserWindow,
  runtime: DesktopProjectRuntime,
  projectRoot: string,
): Promise<void> {
  // Open one remembered project, then remove it and report the error when it is no longer usable.
  try {
    const state = await runtime.open(projectRoot);
    sendProjectState(window, state);
  } catch (error) {
    await runtime.removeRecentProject(projectRoot);
    const safeError = toDesktopOperationError(error);
    await dialog.showMessageBox(window, {
      type: "error",
      title: "无法打开项目",
      message: safeError.message,
    });
  }
}

export function registerDesktopIpc(
  runtime: DesktopProjectRuntime,
  llmSettings: DesktopLlmSettingsService,
  chat: DesktopChatService,
  resolveMainWindow: MainWindowResolver,
  resolveTheme: () => DesktopTheme,
  getThemeSettings: () => DesktopThemeSettings,
  setThemePreference: (preference: "light" | "dark" | "system") => Promise<DesktopThemeSettings>,
): void {
  // Register the complete whitelist of IPC capabilities exposed to the renderer.
  // 1. Register targeted project and manuscript events plus read-only state queries.
  // 2. Register project lifecycle and LLM settings operations with validated safe results.
  // 3. Register native menu handling and connect its existing project action.
  runtime.onManuscriptDocumentsChanged((event) => {
    const window = resolveMainWindow();
    if (window === null || window.isDestroyed()) return;
    window.webContents.send(
      desktopChannels.manuscriptDocumentsChanged,
      manuscriptDocumentsChangedEventSchema.parse(event),
    );
  });

  ipcMain.handle(desktopChannels.getRuntimeInfo, (event) => {
    // Validate the caller and return a schema-checked runtime projection.
    requireMainWindow(event, resolveMainWindow);
    return desktopRuntimeInfoSchema.parse({
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron,
      nodeVersion: process.versions.node,
      platform: process.platform,
    });
  });

  ipcMain.handle(desktopChannels.getThemeBootstrap, (event) => {
    requireMainWindow(event, resolveMainWindow);
    return desktopThemeBootstrapSchema.parse({ theme: resolveTheme() });
  });

  ipcMain.handle(desktopChannels.getThemeSettings, (event) => {
    requireMainWindow(event, resolveMainWindow);
    return desktopThemeSettingsSchema.parse(getThemeSettings());
  });

  ipcMain.handle(desktopChannels.saveThemeSettings, async (event, rawInput: unknown) => {
    requireMainWindow(event, resolveMainWindow);
    try {
      const preference = desktopThemePreferenceSchema.parse(rawInput);
      return desktopThemeSettingsResultSchema.parse({
        outcome: "success",
        settings: await setThemePreference(preference),
      });
    } catch (error) {
      return desktopThemeSettingsResultSchema.parse({
        outcome: "error",
        error: toDesktopOperationError(error),
      });
    }
  });

  ipcMain.handle(desktopChannels.getProjectState, (event) => {
    requireMainWindow(event, resolveMainWindow);
    return runtime.getState();
  });

  ipcMain.handle(desktopChannels.chooseAndOpenProject, async (event) => {
    const window = requireMainWindow(event, resolveMainWindow);
    return chooseAndOpenProject(window, runtime);
  });

  ipcMain.handle(desktopChannels.chooseAndCreateProject, async (event) => {
    const window = requireMainWindow(event, resolveMainWindow);
    return chooseAndCreateProject(window, runtime);
  });

  ipcMain.handle(desktopChannels.closeProject, async (event) => {
    // Close the active project and return its final state through the public result contract.
    const window = requireMainWindow(event, resolveMainWindow);
    try {
      const state = await runtime.close();
      sendProjectState(window, state);
      return desktopProjectOperationResultSchema.parse({ outcome: "success", state });
    } catch (error) {
      return desktopProjectOperationResultSchema.parse({
        outcome: "error",
        state: runtime.getState(),
        error: toDesktopOperationError(error),
      });
    }
  });

  ipcMain.handle(desktopChannels.listManuscriptDocuments, async (event) => {
    // Return only portable identities for readable documents in the current project.
    requireMainWindow(event, resolveMainWindow);
    try {
      const documents = await runtime.listManuscriptDocuments();
      return manuscriptListResultSchema.parse({
        outcome: "success",
        documents,
      });
    } catch (error) {
      return manuscriptListResultSchema.parse({
        outcome: "error",
        error: toDesktopOperationError(error),
      });
    }
  });

  ipcMain.handle(desktopChannels.readManuscriptDocument, async (event, rawInput: unknown) => {
    // Read one listed manuscript through the current project runtime and return no private metadata.
    requireMainWindow(event, resolveMainWindow);
    try {
      const relativePath = manuscriptPathSchema.parse(rawInput);
      const { summary, content } = await runtime.readManuscriptDocument(relativePath);
      return manuscriptReadResultSchema.parse({
        outcome: "success",
        relativePath: summary.relativePath,
        content,
      });
    } catch (error) {
      return manuscriptReadResultSchema.parse({
        outcome: "error",
        error: toDesktopOperationError(error),
      });
    }
  });

  ipcMain.handle(desktopChannels.listMaterials, async (event) => {
    // Return only imported material titles from the active project.
    requireMainWindow(event, resolveMainWindow);
    try {
      const materials = await runtime.listMaterials();
      return materialListResultSchema.parse({
        outcome: "success",
        materials: materials.map(({ title }) => title),
      });
    } catch (error) {
      return materialListResultSchema.parse({
        outcome: "error",
        error: toDesktopOperationError(error),
      });
    }
  });

  ipcMain.handle(desktopChannels.readMaterial, async (event, rawInput: unknown) => {
    // Read one current-project material selected by its validated title.
    requireMainWindow(event, resolveMainWindow);
    try {
      const title = materialTitleSchema.parse(rawInput);
      const material = await runtime.readMaterial(title);
      return materialReadResultSchema.parse({
        outcome: "success",
        title: material.source.title,
        content: material.content,
      });
    } catch (error) {
      return materialReadResultSchema.parse({
        outcome: "error",
        error: toDesktopOperationError(error),
      });
    }
  });

  ipcMain.handle(desktopChannels.chooseAndImportMaterial, async (event) => {
    const window = requireMainWindow(event, resolveMainWindow);
    return await chooseAndImportMaterial(window, runtime);
  });

  ipcMain.handle(desktopChannels.renameMaterial, async (event, rawInput: unknown) => {
    // Rename one material and report conflicts through a native dialog without replacing the list.
    const window = requireMainWindow(event, resolveMainWindow);
    try {
      const input = renameDesktopMaterialInputSchema.parse(rawInput);
      const material = await runtime.renameMaterial(input.title, input.newTitle);
      return materialRenameResultSchema.parse({ outcome: "success", title: material.title });
    } catch (error) {
      const safeError = toDesktopOperationError(error);
      await dialog.showMessageBox(window, {
        type: "error",
        title: "无法重命名资料",
        message: safeError.message,
      });
      return materialRenameResultSchema.parse({ outcome: "error", error: safeError });
    }
  });

  ipcMain.handle(desktopChannels.deleteMaterial, async (event, rawInput: unknown) => {
    // Confirm and delete one material while returning only its safe user-visible title.
    // 1. Validate the requested title before opening the destructive-action confirmation.
    // 2. Preserve all current renderer state when the user cancels the system dialog.
    // 3. Delete through the active project runtime and report errors in a separate native dialog.
    const window = requireMainWindow(event, resolveMainWindow);
    const title = materialTitleSchema.safeParse(rawInput);
    if (!title.success) {
      return materialDeleteResultSchema.parse({
        outcome: "error",
        error: toDesktopOperationError(title.error),
      });
    }
    const confirmation = await dialog.showMessageBox(window, {
      type: "warning",
      title: "删除资料",
      message: `确定删除资料“${title.data}”？`,
      detail: "资料文件、索引和 Embedding 将一并删除。",
      buttons: ["删除资料", "取消"],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    if (confirmation.response !== 0) {
      return materialDeleteResultSchema.parse({ outcome: "cancelled" });
    }
    try {
      const material = await runtime.deleteMaterial(title.data);
      return materialDeleteResultSchema.parse({ outcome: "success", title: material.title });
    } catch (error) {
      const safeError = toDesktopOperationError(error);
      await dialog.showMessageBox(window, {
        type: "error",
        title: "无法删除资料",
        message: safeError.message,
      });
      return materialDeleteResultSchema.parse({ outcome: "error", error: safeError });
    }
  });

  ipcMain.handle(desktopChannels.getLlmApiSettings, async (event) => {
    requireMainWindow(event, resolveMainWindow);
    return desktopLlmApiSettingsSchema.parse(await llmSettings.get());
  });

  ipcMain.handle(desktopChannels.saveLlmApiSettings, async (event, rawInput: unknown) => {
    // Validate the settings write and return only renderer-safe state or a stable error.
    requireMainWindow(event, resolveMainWindow);
    try {
      const input = saveDesktopLlmApiSettingsInputSchema.parse(rawInput);
      return desktopLlmApiSettingsResultSchema.parse({
        outcome: "success",
        settings: await llmSettings.save(input),
      });
    } catch (error) {
      return desktopLlmApiSettingsResultSchema.parse({
        outcome: "error",
        error: toDesktopOperationError(error),
      });
    }
  });

  ipcMain.handle(desktopChannels.listConversations, (event) => {
    // Return only the current project's renderer-safe conversation list.
    requireMainWindow(event, resolveMainWindow);
    try {
      return desktopConversationListResultSchema.parse({
        outcome: "success",
        conversations: runtime.listConversations().map(({ id, title }) => ({ id, title })),
      });
    } catch (error) {
      return desktopConversationListResultSchema.parse({
        outcome: "error",
        error: toDesktopOperationError(error),
      });
    }
  });

  ipcMain.handle(desktopChannels.createConversation, async (event, rawInput: unknown) => {
    // Create a new project-bound conversation before its first streamed message is sent.
    requireMainWindow(event, resolveMainWindow);
    try {
      const input = createDesktopConversationInputSchema.parse(rawInput);
      return desktopConversationCreateResultSchema.parse({
        outcome: "success",
        conversation: await chat.createConversation(input.prompt),
      });
    } catch (error) {
      return desktopConversationCreateResultSchema.parse({
        outcome: "error",
        error: toDesktopOperationError(error),
      });
    }
  });

  ipcMain.handle(desktopChannels.getConversationHistory, (event, rawInput: unknown) => {
    // Return a validated and bounded projection of the selected conversation history.
    // 1. Validate the conversation identifier supplied by the renderer.
    // 2. Query through the current project runtime so project ownership is enforced.
    // 3. Remove internal message fields and validate the complete response contract.
    requireMainWindow(event, resolveMainWindow);
    try {
      const input = getDesktopConversationHistoryInputSchema.parse(rawInput);
      const history = runtime.getRecentConversationHistory(input.conversationId);
      return desktopConversationHistoryResultSchema.parse({
        outcome: "success",
        conversation: { id: history.conversation.id, title: history.conversation.title },
        messages: history.messages.map((message) => ({
          id: message.id,
          role: message.role,
          content: message.content,
          ...(message.reasoningContent === undefined
            ? {}
            : { reasoningContent: message.reasoningContent }),
          sequence: message.sequence,
          createdAt: message.createdAt,
        })),
      });
    } catch (error) {
      return desktopConversationHistoryResultSchema.parse({
        outcome: "error",
        error: toDesktopOperationError(error),
      });
    }
  });

  ipcMain.handle(desktopChannels.sendChatMessage, async (event, rawInput: unknown) => {
    // Validate one desktop chat command and bind its stream to the invoking main window.
    const window = requireMainWindow(event, resolveMainWindow);
    try {
      const input = sendDesktopChatMessageInputSchema.parse(rawInput);
      const result = await chat.send(input, (streamEvent) => {
        if (window.isDestroyed()) return;
        window.webContents.send(desktopChannels.chatMessageEvent, streamEvent);
      });
      return sendDesktopChatMessageResultSchema.parse({
        outcome: "success",
        ...result,
      });
    } catch (error) {
      return sendDesktopChatMessageResultSchema.parse({
        outcome: "error",
        error: toDesktopOperationError(error),
      });
    }
  });

  ipcMain.handle(desktopChannels.resolveToolApproval, (event, rawInput: unknown) => {
    // Resolve only the pending Tool approval correlated to this renderer's chat request.
    requireMainWindow(event, resolveMainWindow);
    try {
      const input = resolveDesktopToolApprovalInputSchema.parse(rawInput);
      if (!chat.resolveToolApproval(input)) {
        throw new AppError("VALIDATION_ERROR", "当前授权请求已失效。");
      }
      return desktopToolApprovalResultSchema.parse({ outcome: "success" });
    } catch (error) {
      return desktopToolApprovalResultSchema.parse({
        outcome: "error",
        error: toDesktopOperationError(error),
      });
    }
  });

  ipcMain.handle(desktopChannels.showWindowMenu, async (event, rawInput: unknown) => {
    // Validate a menu request and display the matching native menu for the calling window.
    const input = showWindowMenuInputSchema.parse(rawInput);
    const window = requireMainWindow(event, resolveMainWindow);
    const recentProjects = await runtime.getRecentProjects();

    Menu.buildFromTemplate(
      createWindowMenuTemplate(input.menuId, process.env.ELECTRON_RENDERER_URL !== undefined, {
        onCreateProject: () => {
          // Keep project-creation failures separate from the current workspace contents.
          void chooseAndCreateProject(window, runtime).then((result) => {
            if (result.outcome !== "error") return;
            void dialog.showMessageBox(window, {
              type: "error",
              title: "无法新建项目",
              message: result.error.message,
            });
          });
        },
        onOpenProject: () => {
          // Run the project picker and show a native error dialog when opening fails.
          void chooseAndOpenProject(window, runtime).then((result) => {
            // Ignore successful or cancelled selections and report only failed opens.
            if (result.outcome !== "error") return;
            void dialog.showMessageBox(window, {
              type: "error",
              title: "无法打开项目",
              message: result.error.message,
            });
          });
        },
        recentProjects: recentProjects.map((projectRoot) => ({
          label: path.basename(projectRoot),
          onOpen: () => {
            void openRecentProject(window, runtime, projectRoot);
          },
        })),
        onClearRecentProjects: () => {
          void runtime.clearRecentProjects();
        },
        themePreference: getThemeSettings().preference,
        onSetThemePreference: (preference) => {
          void setThemePreference(preference).catch((error: unknown) => {
            const safeError = toDesktopOperationError(error);
            void dialog.showMessageBox(window, {
              type: "error",
              title: "无法保存主题设置",
              message: safeError.message,
            });
          });
        },
      }),
    ).popup({ window, x: input.x, y: input.y });
  });
}
