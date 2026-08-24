import { contextBridge, ipcRenderer } from "electron";

import {
  type CleoDocDesktopApi,
  desktopChannels,
  desktopLlmApiSettingsResultSchema,
  desktopLlmApiSettingsSchema,
  desktopConversationHistoryResultSchema,
  desktopConversationListResultSchema,
  desktopChatMessageEventSchema,
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
  sendDesktopChatMessageResultSchema,
  desktopProjectOperationResultSchema,
  desktopProjectStateSchema,
  desktopRuntimeInfoSchema,
  showWindowMenuInputSchema,
  saveDesktopLlmApiSettingsInputSchema,
  renameDesktopMaterialInputSchema,
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
  listManuscriptDocuments: async () =>
    manuscriptListResultSchema.parse(
      await ipcRenderer.invoke(desktopChannels.listManuscriptDocuments),
    ),
  onManuscriptDocumentsChanged: (listener) => {
    // Validate manuscript events and return a disposer for the wrapped IPC listener.
    const handleEvent = (_event: Electron.IpcRendererEvent, rawEvent: unknown): void => {
      listener(manuscriptDocumentsChangedEventSchema.parse(rawEvent));
    };
    ipcRenderer.on(desktopChannels.manuscriptDocumentsChanged, handleEvent);
    return () =>
      ipcRenderer.removeListener(desktopChannels.manuscriptDocumentsChanged, handleEvent);
  },
  readManuscriptDocument: async (relativePath) =>
    manuscriptReadResultSchema.parse(
      await ipcRenderer.invoke(
        desktopChannels.readManuscriptDocument,
        manuscriptPathSchema.parse(relativePath),
      ),
    ),
  listMaterials: async () =>
    materialListResultSchema.parse(await ipcRenderer.invoke(desktopChannels.listMaterials)),
  readMaterial: async (title) =>
    materialReadResultSchema.parse(
      await ipcRenderer.invoke(desktopChannels.readMaterial, materialTitleSchema.parse(title)),
    ),
  chooseAndImportMaterial: async () =>
    materialImportResultSchema.parse(
      await ipcRenderer.invoke(desktopChannels.chooseAndImportMaterial),
    ),
  renameMaterial: async (input) =>
    materialRenameResultSchema.parse(
      await ipcRenderer.invoke(
        desktopChannels.renameMaterial,
        renameDesktopMaterialInputSchema.parse(input),
      ),
    ),
  deleteMaterial: async (title) =>
    materialDeleteResultSchema.parse(
      await ipcRenderer.invoke(desktopChannels.deleteMaterial, materialTitleSchema.parse(title)),
    ),
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
  onChatMessageEvent: (listener) => {
    // Validate streaming chat events and return a disposer for the wrapped IPC listener.
    const handleEvent = (_event: Electron.IpcRendererEvent, rawEvent: unknown): void => {
      listener(desktopChatMessageEventSchema.parse(rawEvent));
    };
    ipcRenderer.on(desktopChannels.chatMessageEvent, handleEvent);
    return () => ipcRenderer.removeListener(desktopChannels.chatMessageEvent, handleEvent);
  },
};

contextBridge.exposeInMainWorld("cleodoc", desktopApi);
