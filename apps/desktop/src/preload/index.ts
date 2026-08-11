import { contextBridge, ipcRenderer } from "electron";

import {
  type CleoDocDesktopApi,
  desktopChannels,
  desktopRuntimeInfoSchema,
  showWindowMenuInputSchema,
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
};

contextBridge.exposeInMainWorld("cleodoc", desktopApi);
