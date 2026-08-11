import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

const fromRoot = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  main: {
    build: {
      outDir: "out/main",
      rollupOptions: {
        input: fromRoot("./apps/desktop/src/main/index.ts"),
        output: { entryFileNames: "index.js" },
      },
    },
  },
  preload: {
    build: {
      externalizeDeps: { exclude: ["zod"] },
      outDir: "out/preload",
      rollupOptions: {
        input: fromRoot("./apps/desktop/src/preload/index.ts"),
        output: { entryFileNames: "index.cjs", format: "cjs" },
      },
    },
  },
  renderer: {
    root: fromRoot("./apps/desktop/src/renderer"),
    plugins: [react()],
    build: {
      outDir: fromRoot("./out/renderer"),
      rollupOptions: {
        input: fromRoot("./apps/desktop/src/renderer/index.html"),
      },
    },
  },
});
