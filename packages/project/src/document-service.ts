import { createHash } from "node:crypto";
import { watch } from "node:fs";
import { lstat, readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

import type { DocumentSummary, SavedDocument } from "../../contracts/src/index.js";
import { AppError } from "../../contracts/src/index.js";
import { writeFileAtomic } from "./atomic-file.js";
import { resolveInsideProject, toPortablePath } from "./safe-path.js";

const MARKDOWN_DOCUMENT_EXTENSIONS = new Set([".md"]);
const READABLE_DOCUMENT_EXTENSIONS = new Set([".md", ".txt"]);
const MANUSCRIPT_WATCH_DEBOUNCE_MS = 180;

export class DocumentService {
  constructor(private readonly projectRoot: string) {}

  async list(): Promise<DocumentSummary[]> {
    return this.listDocuments(MARKDOWN_DOCUMENT_EXTENSIONS);
  }

  async listReadableDocuments(): Promise<DocumentSummary[]> {
    return this.listDocuments(READABLE_DOCUMENT_EXTENSIONS);
  }

  async listReadableDocumentPaths(): Promise<string[]> {
    // List readable manuscript paths without loading their file contents.
    const manuscript = await resolveInsideProject(this.projectRoot, "manuscript");
    return await collectPortableDocumentPaths(
      manuscript.absolutePath,
      manuscript.absolutePath,
      READABLE_DOCUMENT_EXTENSIONS,
    );
  }

  async watchReadableDocumentPaths(
    initialPaths: readonly string[],
    onChange: (paths: readonly string[]) => void,
    onError: (error: unknown) => void,
  ): Promise<() => void> {
    // Start a native watcher from an already loaded manuscript path snapshot.
    const manuscript = await resolveInsideProject(this.projectRoot, "manuscript");
    return createReadableDocumentWatcher({
      manuscriptRoot: manuscript.absolutePath,
      initialPaths,
      onChange,
      onError,
    });
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

async function collectPortableDocumentPaths(
  manuscriptRoot: string,
  directory: string,
  supportedExtensions: ReadonlySet<string>,
): Promise<string[]> {
  // Collect supported paths under one manuscript directory without reading file contents.
  const files = await collectDocumentFiles(manuscriptRoot, directory, supportedExtensions);
  return files
    .map((filePath) => `manuscript/${toPortablePath(path.relative(manuscriptRoot, filePath))}`)
    .sort((left, right) => left.localeCompare(right, "zh-CN"));
}

function createReadableDocumentWatcher(options: {
  readonly manuscriptRoot: string;
  readonly initialPaths: readonly string[];
  readonly onChange: (paths: readonly string[]) => void;
  readonly onError: (error: unknown) => void;
}): () => void {
  // Maintain the readable manuscript list from native file-system notifications.
  // 1. Batch duplicate native events and retain their affected relative paths.
  // 2. Update individual files or directories without scanning the manuscript root.
  // 3. Scan the full root only when the operating system omits a usable filename.
  const documents = new Set(options.initialPaths);
  const pendingPaths = new Set<string>();
  let fullScanRequired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let operationTail = Promise.resolve();

  const flush = async (): Promise<void> => {
    // Apply one event batch and publish only a changed, sorted path snapshot.
    // 1. Capture and clear pending state so later events form a new batch.
    // 2. Refresh either the full root or only the paths named by the operating system.
    // 3. Ignore settled work after close and suppress unchanged snapshots.
    const scanAll = fullScanRequired;
    const changedPaths = [...pendingPaths];
    fullScanRequired = false;
    pendingPaths.clear();
    const next = scanAll
      ? new Set(
          await collectPortableDocumentPaths(
            options.manuscriptRoot,
            options.manuscriptRoot,
            READABLE_DOCUMENT_EXTENSIONS,
          ),
        )
      : new Set(documents);
    if (!scanAll) {
      for (const relativePath of changedPaths) {
        await applyReadableDocumentChange(options, next, relativePath);
      }
    }
    if (closed) return;
    const currentPaths = [...documents].sort((left, right) => left.localeCompare(right, "zh-CN"));
    const nextPaths = [...next].sort((left, right) => left.localeCompare(right, "zh-CN"));
    if (samePaths(currentPaths, nextPaths)) return;
    documents.clear();
    for (const relativePath of nextPaths) documents.add(relativePath);
    options.onChange(nextPaths);
  };

  const schedule = (filename: string | null): void => {
    // Queue one native event and restart the short batching window.
    const relativePath = filename === null ? null : normalizeWatchedManuscriptPath(filename);
    if (relativePath === null) fullScanRequired = true;
    else pendingPaths.add(relativePath);
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      operationTail = operationTail.then(flush, flush).catch(options.onError);
    }, MANUSCRIPT_WATCH_DEBOUNCE_MS);
  };

  const watcher = watch(
    options.manuscriptRoot,
    { encoding: "utf8", persistent: false, recursive: true },
    (_eventType, filename) => schedule(filename),
  );
  watcher.on("error", (error) => {
    if (!closed) options.onError(error);
  });
  return () => {
    closed = true;
    if (timer !== undefined) clearTimeout(timer);
    watcher.close();
  };
}

async function applyReadableDocumentChange(
  options: { readonly manuscriptRoot: string },
  documents: Set<string>,
  relativePath: string,
): Promise<void> {
  // Reconcile one changed file or directory against the current path snapshot.
  // 1. Remove the previous file or directory subtree from the snapshot.
  // 2. Inspect only the changed path and add a supported file when it exists.
  // 3. Scan only that directory when a directory itself was added or renamed.
  removePathAndChildren(documents, relativePath);
  let resolved: Awaited<ReturnType<typeof resolveInsideProject>>;
  try {
    resolved = await resolveInsideProject(
      options.manuscriptRoot,
      relativePath.slice("manuscript/".length),
    );
  } catch (error) {
    if (error instanceof AppError && error.code === "PATH_OUTSIDE_PROJECT") return;
    throw error;
  }
  const metadata = await lstat(resolved.absolutePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (metadata === null || metadata.isSymbolicLink()) return;
  if (metadata.isFile()) {
    if (READABLE_DOCUMENT_EXTENSIONS.has(path.extname(relativePath).toLowerCase())) {
      documents.add(relativePath);
    }
    return;
  }
  if (!metadata.isDirectory()) return;
  const nestedPaths = await collectPortableDocumentPaths(
    options.manuscriptRoot,
    resolved.absolutePath,
    READABLE_DOCUMENT_EXTENSIONS,
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const nestedPath of nestedPaths) documents.add(nestedPath);
}

function normalizeWatchedManuscriptPath(filename: string): string | null {
  // Convert a native watcher filename into a safe project-relative manuscript path.
  const portable = toPortablePath(filename.trim());
  if (
    portable.length === 0 ||
    portable.includes("\0") ||
    path.posix.isAbsolute(portable) ||
    path.win32.isAbsolute(portable) ||
    portable.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    return null;
  }
  return `manuscript/${portable}`;
}

function removePathAndChildren(documents: Set<string>, relativePath: string): void {
  const childPrefix = `${relativePath}/`;
  for (const existing of documents) {
    if (existing === relativePath || existing.startsWith(childPrefix)) documents.delete(existing);
  }
}

function samePaths(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
