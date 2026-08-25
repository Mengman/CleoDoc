import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.js";

const root = document.getElementById("root");

if (root === null) throw new Error("找不到 CleoDoc Renderer 根节点。");
const rendererRoot = root;

async function startRenderer(): Promise<void> {
  // Apply the resolved desktop theme before React renders the workspace.
  const initialTheme = await window.cleodoc.getThemeBootstrap();
  document.documentElement.dataset.theme = initialTheme.theme;
  window.cleodoc.onThemeChanged((theme) => {
    document.documentElement.dataset.theme = theme.theme;
  });
  createRoot(rendererRoot).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void startRenderer();
