import { contextBridge, ipcRenderer } from "electron";

import {
  type CleoDocDesktopApi,
  desktopChannels,
  desktopLlmApiSettingsResultSchema,
  desktopLlmApiSettingsSchema,
  desktopConversationHistoryResultSchema,
  desktopConversationListResultSchema,
  sendDesktopChatMessageResultSchema,
  desktopProjectOperationResultSchema,
  desktopProjectStateSchema,
  desktopRuntimeInfoSchema,
  showWindowMenuInputSchema,
  saveDesktopLlmApiSettingsInputSchema,
  getDesktopConversationHistoryInputSchema,
  sendDesktopChatMessageInputSchema,
} from "../shared/desktop-api.js";

const desktopApi: CleoDocDesktopApi = {
  getRuntimeInfo: async () =>
    desktopRuntimeInfoSchema.parse(await ipcRenderer.invoke(desktopChannels.getRuntimeInfo)),
  showWindowMenu: async (input) => {
    await ipcRenderer.invoke(
      desktopChannels.showWindowMenu,
      showWindowMenuInputSchema.parse(input),
    );
  },
  getProjectState: async () =>
    desktopProjectStateSchema.parse(await ipcRenderer.invoke(desktopChannels.getProjectState)),
  chooseAndOpenProject: async () =>
    desktopProjectOperationResultSchema.parse(
      await ipcRenderer.invoke(desktopChannels.chooseAndOpenProject),
    ),
  closeProject: async () =>
    desktopProjectOperationResultSchema.parse(
      await ipcRenderer.invoke(desktopChannels.closeProject),
    ),
  onProjectStateChanged: (listener) => {
    // Validate project-state events and return a disposer for the wrapped IPC listener.
    const handleStateChanged = (_event: Electron.IpcRendererEvent, rawState: unknown): void => {
      listener(desktopProjectStateSchema.parse(rawState));
    };
    ipcRenderer.on(desktopChannels.projectStateChanged, handleStateChanged);
    return () =>
      ipcRenderer.removeListener(desktopChannels.projectStateChanged, handleStateChanged);
  },
  getLlmApiSettings: async () =>
    desktopLlmApiSettingsSchema.parse(await ipcRenderer.invoke(desktopChannels.getLlmApiSettings)),
  saveLlmApiSettings: async (input) =>
    desktopLlmApiSettingsResultSchema.parse(
      await ipcRenderer.invoke(
        desktopChannels.saveLlmApiSettings,
        saveDesktopLlmApiSettingsInputSchema.parse(input),
      ),
    ),
  listConversations: async () =>
    desktopConversationListResultSchema.parse(
      await ipcRenderer.invoke(desktopChannels.listConversations),
    ),
  getConversationHistory: async (input) =>
    desktopConversationHistoryResultSchema.parse(
      await ipcRenderer.invoke(
        desktopChannels.getConversationHistory,
        getDesktopConversationHistoryInputSchema.parse(input),
      ),
    ),
  sendChatMessage: async (input) =>
    sendDesktopChatMessageResultSchema.parse(
      await ipcRenderer.invoke(
        desktopChannels.sendChatMessage,
        sendDesktopChatMessageInputSchema.parse(input),
      ),
    ),
};

contextBridge.exposeInMainWorld("cleodoc", desktopApi);
