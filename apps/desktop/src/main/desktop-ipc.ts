import { app, BrowserWindow, dialog, ipcMain, Menu, type IpcMainInvokeEvent } from "electron";

import {
  desktopChannels,
  desktopConversationHistoryResultSchema,
  desktopConversationListResultSchema,
  desktopLlmApiSettingsResultSchema,
  desktopLlmApiSettingsSchema,
  desktopProjectOperationResultSchema,
  desktopProjectStateSchema,
  desktopRuntimeInfoSchema,
  getDesktopConversationHistoryInputSchema,
  sendDesktopChatMessageInputSchema,
  sendDesktopChatMessageResultSchema,
  showWindowMenuInputSchema,
  saveDesktopLlmApiSettingsInputSchema,
  type DesktopProjectOperationResult,
} from "../shared/desktop-api.js";
import { toDesktopOperationError } from "./desktop-project-runtime.js";
import type { DesktopProjectRuntime } from "./desktop-project-runtime.js";
import type { DesktopLlmSettingsService } from "./desktop-llm-settings.js";
import type { DesktopChatService } from "./desktop-chat-service.js";
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
  // Let the user select a project and return a validated, renderer-safe result.
  // 1. Open the native directory picker and preserve the current state on cancellation.
  // 2. Ask the project runtime to close the old project and open the selected project.
  // 3. Broadcast the resulting state and convert failures into the public error contract.
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

export function registerDesktopIpc(
  runtime: DesktopProjectRuntime,
  llmSettings: DesktopLlmSettingsService,
  chat: DesktopChatService,
): void {
  // Register the complete whitelist of IPC capabilities exposed to the renderer.
  // 1. Register read-only runtime and project-state queries.
  // 2. Register project lifecycle and LLM settings operations with validated safe results.
  // 3. Register native menu handling and connect its existing project action.
  ipcMain.handle(desktopChannels.getRuntimeInfo, (event) => {
    // Validate the caller and return a schema-checked runtime projection.
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
    // Close the active project and return its final state through the public result contract.
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

  ipcMain.handle(desktopChannels.getLlmApiSettings, async (event) => {
    requireMainWindow(event);
    return desktopLlmApiSettingsSchema.parse(await llmSettings.get());
  });

  ipcMain.handle(desktopChannels.saveLlmApiSettings, async (event, rawInput: unknown) => {
    // Validate the settings write and return only renderer-safe state or a stable error.
    requireMainWindow(event);
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
    requireMainWindow(event);
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

  ipcMain.handle(desktopChannels.getConversationHistory, (event, rawInput: unknown) => {
    // Return a validated and bounded projection of the selected conversation history.
    // 1. Validate the conversation identifier supplied by the renderer.
    // 2. Query through the current project runtime so project ownership is enforced.
    // 3. Remove internal message fields and validate the complete response contract.
    requireMainWindow(event);
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
    // Send a validated prompt and return only the refreshed renderer-safe conversation projection.
    requireMainWindow(event);
    try {
      const input = sendDesktopChatMessageInputSchema.parse(rawInput);
      const result = await chat.send(input);
      return sendDesktopChatMessageResultSchema.parse({
        outcome: "success",
        conversation: { id: result.conversation.id, title: result.conversation.title },
        messages: result.messages.map((message) => ({
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
      return sendDesktopChatMessageResultSchema.parse({
        outcome: "error",
        error: toDesktopOperationError(error),
      });
    }
  });

  ipcMain.handle(desktopChannels.showWindowMenu, (event, rawInput: unknown) => {
    // Validate a menu request and display the matching native menu for the calling window.
    const input = showWindowMenuInputSchema.parse(rawInput);
    const window = requireMainWindow(event);

    Menu.buildFromTemplate(
      createWindowMenuTemplate(input.menuId, process.env.ELECTRON_RENDERER_URL !== undefined, {
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
      }),
    ).popup({ window, x: input.x, y: input.y });
  });
}
