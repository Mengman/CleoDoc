import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";

import { AppError } from "../../contracts/src/index.js";
import type { ProjectInstructionSnapshot } from "../../database/src/index.js";

const MAX_INSTRUCTIONS_BYTES = 64 * 1024;

export interface LoadedProjectInstructions extends ProjectInstructionSnapshot {
  loadedAt: string;
  warning: string | null;
}

export async function loadProjectInstructions(
  projectRoot: string,
): Promise<LoadedProjectInstructions> {
  const entries = await readdir(projectRoot);
  const exact = entries.includes("AGENTS.md")
    ? "AGENTS.md"
    : entries.includes("agents.md")
      ? "agents.md"
      : null;
  const variants = entries.filter((entry) => entry.toLowerCase() === "agents.md");
  const warning =
    variants.length > 1
      ? "项目根目录存在多个 AGENTS.md 大小写变体；本 Session 使用 AGENTS.md。"
      : null;
  if (exact === null) {
    return { path: null, content: null, hash: null, loadedAt: new Date().toISOString(), warning };
  }

  const absolutePath = path.join(projectRoot, exact);
  const stats = await lstat(absolutePath);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new AppError(
      "VALIDATION_ERROR",
      `${exact} 必须是项目根目录中的普通文件，不能是符号链接。`,
    );
  }
  if (stats.size > MAX_INSTRUCTIONS_BYTES) {
    throw new AppError("VALIDATION_ERROR", `${exact} 超过 64 KiB，无法作为 Session 指令加载。`);
  }
  const bytes = await readFile(absolutePath);
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new AppError("VALIDATION_ERROR", `${exact} 不是有效的 UTF-8 文本。`, { cause: error });
  }
  return {
    path: exact,
    content,
    hash: createHash("sha256").update(bytes).digest("hex"),
    loadedAt: new Date().toISOString(),
    warning,
  };
}
