import { createHash } from "node:crypto";
import { lstat, readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

import type { DocumentSummary, SavedDocument } from "../../contracts/src/index.js";
import { AppError } from "../../contracts/src/index.js";
import { writeFileAtomic } from "./atomic-file.js";
import { resolveInsideProject, toPortablePath } from "./safe-path.js";

const MARKDOWN_DOCUMENT_EXTENSIONS = new Set([".md"]);
const READABLE_DOCUMENT_EXTENSIONS = new Set([".md", ".txt"]);

export class DocumentService {
  constructor(private readonly projectRoot: string) {}

  async list(): Promise<DocumentSummary[]> {
    return this.listDocuments(MARKDOWN_DOCUMENT_EXTENSIONS);
  }

  async listReadableDocuments(): Promise<DocumentSummary[]> {
    return this.listDocuments(READABLE_DOCUMENT_EXTENSIONS);
  }

  async read(relativePath: string): Promise<{ summary: DocumentSummary; content: string }> {
    return this.readDocument(relativePath, MARKDOWN_DOCUMENT_EXTENSIONS);
  }

  async readReadableDocument(
    relativePath: string,
  ): Promise<{ summary: DocumentSummary; content: string }> {
    return this.readDocument(relativePath, READABLE_DOCUMENT_EXTENSIONS);
  }

  async save(relativePath: string, content: string, overwrite = false): Promise<SavedDocument> {
    const normalized = normalizeDocumentPath(relativePath, MARKDOWN_DOCUMENT_EXTENSIONS);
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

  async delete(relativePath: string): Promise<DocumentSummary> {
    const document = await this.read(relativePath);
    const resolved = await resolveInsideProject(this.projectRoot, document.summary.relativePath);
    await rm(resolved.absolutePath);
    return document.summary;
  }

  private async listDocuments(
    supportedExtensions: ReadonlySet<string>,
  ): Promise<DocumentSummary[]> {
    // List supported manuscript files as stable document summaries in portable path order.
    const manuscript = await resolveInsideProject(this.projectRoot, "manuscript");
    const files = await collectDocumentFiles(
      manuscript.absolutePath,
      manuscript.absolutePath,
      supportedExtensions,
    );
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

  private async readDocument(
    relativePath: string,
    supportedExtensions: ReadonlySet<string>,
  ): Promise<{ summary: DocumentSummary; content: string }> {
    // Read one supported manuscript document through the project path boundary.
    // 1. Validate the project-relative path against only the requested readable formats.
    // 2. Read the UTF-8 content and convert a missing file to a stable document error.
    // 3. Return the content with a current immutable summary projection.
    const normalized = normalizeDocumentPath(relativePath, supportedExtensions);
    const resolved = await resolveInsideProject(this.projectRoot, normalized);
    const content = await readFile(resolved.absolutePath, "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") {
          throw new AppError("DOCUMENT_NOT_FOUND", "找不到指定文档。", {
            details: { document: relativePath },
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
}

export function contentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function normalizeDocumentPath(input: string, supportedExtensions: ReadonlySet<string>): string {
  // Normalize and validate a manuscript path without broadening the requested format boundary.
  const portable = toPortablePath(input.trim());
  if (
    path.posix.isAbsolute(portable) ||
    path.win32.isAbsolute(portable) ||
    portable.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new AppError("PATH_OUTSIDE_PROJECT", "路径必须位于当前项目的 manuscript 目录内。");
  }
  const withRoot = portable.startsWith("manuscript/") ? portable : `manuscript/${portable}`;
  if (!supportedExtensions.has(path.posix.extname(withRoot).toLowerCase())) {
    const formats = [...supportedExtensions].join("、");
    throw new AppError("VALIDATION_ERROR", `正文文档必须使用 ${formats} 扩展名。`);
  }
  return withRoot;
}

function createSummary(relativePath: string, content: string, updatedAt: string): DocumentSummary {
  return {
    relativePath,
    contentHash: contentHash(content),
    size: Buffer.byteLength(content, "utf8"),
    updatedAt,
  };
}

async function collectDocumentFiles(
  root: string,
  directory: string,
  supportedExtensions: ReadonlySet<string>,
): Promise<string[]> {
  // Recursively collect supported regular files while ignoring symbolic links and escaped paths.
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      continue;
    }
    if (entry.isDirectory()) {
      files.push(...(await collectDocumentFiles(root, entryPath, supportedExtensions)));
    } else if (entry.isFile() && supportedExtensions.has(path.extname(entry.name).toLowerCase())) {
      const relative = path.relative(root, entryPath);
      if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
        files.push(entryPath);
      }
    }
  }
  return files;
}
