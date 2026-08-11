/// <reference types="vite/client" />

import type { CleoDocDesktopApi } from "../../shared/desktop-api.js";

declare global {
  interface Window {
    readonly cleodoc: CleoDocDesktopApi;
  }
}

export {};
