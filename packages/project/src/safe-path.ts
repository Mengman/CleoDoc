import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import { AppError } from "../../contracts/src/index.js";

export function toPortablePath(relativePath: string): string {
  return relativePath.replaceAll("\\", "/");
}

export async function resolveInsideProject(
  projectRoot: string,
  requestedRelativePath: string,
): Promise<{ absolutePath: string; relativePath: string }> {
  const portable = toPortablePath(requestedRelativePath.trim());
  if (
    portable.length === 0 ||
    portable.includes("\0") ||
    path.posix.isAbsolute(portable) ||
    path.win32.isAbsolute(portable)
  ) {
    throw outsidePathError();
  }

  const segments = portable.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw outsidePathError();
  }

  const canonicalRoot = await realpath(projectRoot).catch((error: unknown) => {
    throw new AppError("PROJECT_NOT_FOUND", "项目目录不存在。", { cause: error });
  });
  const absolutePath = path.join(canonicalRoot, ...segments);
  const relative = path.relative(canonicalRoot, absolutePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw outsidePathError();
  }

  let current = canonicalRoot;
  for (const segment of segments) {
    current = path.join(current, segment);
    const stat = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return null;
      }
      throw error;
    });
    if (stat?.isSymbolicLink() === true) {
      throw new AppError("PATH_OUTSIDE_PROJECT", "项目路径不能经过符号链接。", {
        details: { relativePath: portable },
      });
    }
  }

  return { absolutePath, relativePath: segments.join("/") };
}

function outsidePathError(): AppError {
  return new AppError("PATH_OUTSIDE_PROJECT", "路径必须位于当前项目目录内。");
}
