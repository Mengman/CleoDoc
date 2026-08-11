import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.js";

const root = document.getElementById("root");

if (root === null) throw new Error("找不到 CleoDoc Renderer 根节点。");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
