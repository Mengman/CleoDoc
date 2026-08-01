import { createHash } from "node:crypto";
import { lstat, readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

import type { DocumentSummary, SavedDocument } from "../../contracts/src/index.js";
import { AppError } from "../../contracts/src/index.js";
import { writeFileAtomic } from "./atomic-file.js";
import { resolveInsideProject, toPortablePath } from "./safe-path.js";

export class DocumentService {
  constructor(private readonly projectRoot: string) {}

  async list(): Promise<DocumentSummary[]> {
    const manuscript = await resolveInsideProject(this.projectRoot, "manuscript");
    const files = await collectMarkdownFiles(manuscript.absolutePath, manuscript.absolutePath);
    const summaries = await Promise.all(
      files.map(async (filePath) => {
        const content = await readFile(filePath, "utf8");
        const metadata = await stat(filePath);
        const nestedPath = toPortablePath(path.relative(manuscript.absolutePath, filePath));
        return createSummary(`manuscript/${nestedPath}`, content, metadata.mtime.toISOString());
      }),
    );
    return summaries.sort((left, right) =>
      left.relativePath.localeCompare(right.relativePath, "zh-CN"),
    );
  }

  async read(idOrPath: string): Promise<{ summary: DocumentSummary; content: string }> {
    const relativePath = await this.resolveDocumentReference(idOrPath);
    const resolved = await resolveInsideProject(this.projectRoot, relativePath);
    const content = await readFile(resolved.absolutePath, "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") {
          throw new AppError("DOCUMENT_NOT_FOUND", "找不到指定文档。", {
            details: { document: idOrPath },
          });
        }
        throw error;
      },
    );
    const metadata = await stat(resolved.absolutePath);
    return {
      summary: createSummary(resolved.relativePath, content, metadata.mtime.toISOString()),
      content,
    };
  }

  async save(relativePath: string, content: string, overwrite = false): Promise<SavedDocument> {
    const normalized = normalizeDocumentPath(relativePath);
    const resolved = await resolveInsideProject(this.projectRoot, normalized);
    const existing = await lstat(resolved.absolutePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return null;
      }
      throw error;
    });
    if (existing?.isDirectory() === true) {
      throw new AppError("VALIDATION_ERROR", "文档路径指向了目录。");
    }
    if (existing !== null && !overwrite) {
      throw new AppError("DOCUMENT_ALREADY_EXISTS", "文档已存在，需要明确确认后才能覆盖。", {
        details: { relativePath: resolved.relativePath },
      });
    }

    await writeFileAtomic(resolved.absolutePath, content);
    const metadata = await stat(resolved.absolutePath);
    return {
      ...createSummary(resolved.relativePath, content, metadata.mtime.toISOString()),
      created: existing === null,
    };
  }

  async delete(idOrPath: string): Promise<DocumentSummary> {
    const document = await this.read(idOrPath);
    const resolved = await resolveInsideProject(this.projectRoot, document.summary.relativePath);
    await rm(resolved.absolutePath);
    return document.summary;
  }

  private async resolveDocumentReference(idOrPath: string): Promise<string> {
    if (!idOrPath.startsWith("doc_")) {
      return normalizeDocumentPath(idOrPath);
    }
    const found = (await this.list()).find((document) => document.id === idOrPath);
    if (found === undefined) {
      throw new AppError("DOCUMENT_NOT_FOUND", "找不到指定文档。", {
        details: { document: idOrPath },
      });
    }
    return found.relativePath;
  }
}

export function contentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function normalizeDocumentPath(input: string): string {
  const portable = toPortablePath(input.trim());
  if (
    path.posix.isAbsolute(portable) ||
    path.win32.isAbsolute(portable) ||
    portable.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new AppError("PATH_OUTSIDE_PROJECT", "路径必须位于当前项目的 manuscript 目录内。");
  }
  const withRoot = portable.startsWith("manuscript/") ? portable : `manuscript/${portable}`;
  if (!withRoot.toLowerCase().endsWith(".md")) {
    throw new AppError("VALIDATION_ERROR", "正文文档必须使用 .md 扩展名。");
  }
  return withRoot;
}

function createSummary(relativePath: string, content: string, updatedAt: string): DocumentSummary {
  return {
    id: `doc_${createHash("sha256").update(relativePath).digest("hex").slice(0, 16)}`,
    relativePath,
    contentHash: contentHash(content),
    size: Buffer.byteLength(content, "utf8"),
    updatedAt,
  };
}

async function collectMarkdownFiles(root: string, directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      continue;
    }
    if (entry.isDirectory()) {
      files.push(...(await collectMarkdownFiles(root, entryPath)));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      const relative = path.relative(root, entryPath);
      if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
        files.push(entryPath);
      }
    }
  }
  return files;
}
