import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";

import type {
  KnowledgeSource,
  MaterialImportResult,
  MaterialWithContent,
} from "../../contracts/src/index.js";
import {
  AppError,
  KNOWLEDGE_SOURCE_SCHEMA_VERSION,
  knowledgeSourceSchema,
} from "../../contracts/src/index.js";
import { MaterialRepository, ProjectDatabase } from "../../database/src/index.js";
import { parseDocument } from "@cleodoc/document-ingestion";
import {
  ProjectService,
  resolveInsideProject,
  writeFileAtomic,
  writeJsonAtomic,
} from "../../project/src/index.js";
import { decodeMaterialText } from "./text-decoding.js";
import type { MaterialInputEncoding } from "./text-decoding.js";

interface MaterialMetadataOptions {
  title?: string;
  sourceLabel?: string;
  tags?: readonly string[];
}

export interface AddFileMaterialOptions extends MaterialMetadataOptions {
  encoding?: MaterialInputEncoding;
}

export interface AddTextMaterialOptions extends MaterialMetadataOptions {
  format?: "text" | "markdown";
}

export class MaterialService {
  private readonly repository: MaterialRepository;

  private constructor(
    private readonly projectRoot: string,
    private readonly projectId: string,
    private readonly database: ProjectDatabase,
    private readonly maxImportBytes: number,
  ) {
    this.repository = new MaterialRepository(database);
  }

  static async open(
    projectRoot: string,
    options: { database: { busyTimeoutMs: number }; maxImportBytes: number },
  ): Promise<MaterialService> {
    const project = await new ProjectService(options.database).open(projectRoot);
    await ensureMaterialDirectories(project.root);
    const database = await ProjectDatabase.open(project.root, options.database);
    const service = new MaterialService(
      project.root,
      project.manifest.id,
      database,
      options.maxImportBytes,
    );
    try {
      await service.synchronizeProjection();
      return service;
    } catch (error) {
      await database.close();
      throw error;
    }
  }

  async addFile(
    filePath: string,
    options: AddFileMaterialOptions = {},
  ): Promise<MaterialImportResult> {
    const absoluteInputPath = path.resolve(filePath);
    const fileInfo = await lstat(absoluteInputPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        throw new AppError("VALIDATION_ERROR", "要导入的资料文件不存在。");
      }
      throw error;
    });
    if (!fileInfo.isFile()) {
      throw new AppError("VALIDATION_ERROR", "只能导入 TXT 或 Markdown 文件。");
    }
    const format = materialFormatFromPath(absoluteInputPath);
    const decoded = await readMaterialFile(
      absoluteInputPath,
      options.encoding,
      this.maxImportBytes,
    );
    const originalFileName = path.basename(absoluteInputPath);
    return await this.addContent(decoded.content, {
      origin: "file",
      format,
      inputEncoding: decoded.inputEncoding,
      title: options.title ?? path.basename(originalFileName, path.extname(originalFileName)),
      sourceLabel: options.sourceLabel ?? originalFileName,
      originalFileName,
      tags: options.tags,
    });
  }

  async addText(
    content: string,
    options: AddTextMaterialOptions = {},
  ): Promise<MaterialImportResult> {
    return await this.addContent(content, {
      origin: "paste",
      format: options.format ?? "text",
      inputEncoding: "utf-8",
      title: options.title ?? defaultPastedTitle(),
      sourceLabel: options.sourceLabel ?? null,
      originalFileName: null,
      tags: options.tags,
    });
  }

  async list(): Promise<KnowledgeSource[]> {
    await this.synchronizeProjection();
    return this.repository.list();
  }

  async get(id: string): Promise<MaterialWithContent> {
    await this.synchronizeProjection();
    const source = this.repository.get(id);
    if (source === null) {
      throw materialNotFound(id);
    }
    return { source, content: await this.readSourceContent(source) };
  }

  async rename(id: string, title: string): Promise<KnowledgeSource> {
    const current = await this.get(id);
    const updated = parseKnowledgeSource({
      ...current.source,
      title: normalizeTitle(title),
      updatedAt: new Date().toISOString(),
    });
    const metadata = await this.resolveMetadataPath(id);
    await writeJsonAtomic(metadata.absolutePath, updated);
    try {
      await this.repository.upsert(updated);
      return updated;
    } catch (error) {
      await writeJsonAtomic(metadata.absolutePath, current.source).catch(() => undefined);
      throw error;
    }
  }

  async remove(id: string): Promise<KnowledgeSource> {
    const current = await this.get(id);
    const content = await this.readSourceContent(current.source);
    const sourcePath = await resolveInsideProject(this.projectRoot, current.source.relativePath);
    const metadataPath = await this.resolveMetadataPath(id);
    const derivedDocumentPath = await this.resolveDerivedDocumentPath(id);
    const metadataContent = await readFile(metadataPath.absolutePath, "utf8");
    const derivedDocumentContent = await readOptionalFile(derivedDocumentPath.absolutePath);

    await rm(metadataPath.absolutePath);
    try {
      await rm(sourcePath.absolutePath);
      await rm(derivedDocumentPath.absolutePath, { force: true });
      await this.repository.remove(id);
      return current.source;
    } catch (error) {
      await writeFileAtomic(sourcePath.absolutePath, content).catch(() => undefined);
      await writeFileAtomic(metadataPath.absolutePath, metadataContent).catch(() => undefined);
      if (derivedDocumentContent !== null) {
        await writeFileAtomic(derivedDocumentPath.absolutePath, derivedDocumentContent).catch(
          () => undefined,
        );
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.database.close();
  }

  private async addContent(
    content: string,
    input: {
      origin: KnowledgeSource["origin"];
      format: KnowledgeSource["format"];
      inputEncoding: MaterialInputEncoding;
      title: string;
      sourceLabel: string | null;
      originalFileName: string | null;
      tags?: readonly string[];
    },
  ): Promise<MaterialImportResult> {
    assertMaterialContent(content, this.maxImportBytes);
    await this.synchronizeProjection();
    const contentHash = hashContent(content);
    const duplicate = this.repository.findByContentHash(contentHash);
    if (duplicate !== null) {
      return { source: duplicate, created: false, inputEncoding: input.inputEncoding };
    }

    const parsedDocument = parseDocument({ format: input.format, content });
    const id = randomUUID();
    const extension = input.format === "markdown" ? "md" : "txt";
    const relativePath = `materials/${id}.${extension}`;
    const now = new Date().toISOString();
    const source = parseKnowledgeSource({
      schemaVersion: KNOWLEDGE_SOURCE_SCHEMA_VERSION,
      id,
      projectId: this.projectId,
      type: "material",
      origin: input.origin,
      format: input.format,
      title: normalizeTitle(input.title),
      sourceLabel: normalizeOptionalLabel(input.sourceLabel),
      originalFileName: input.originalFileName,
      tags: normalizeTags(input.tags ?? []),
      relativePath,
      contentHash,
      size: Buffer.byteLength(content, "utf8"),
      createdAt: now,
      updatedAt: now,
    });
    const sourcePath = await resolveInsideProject(this.projectRoot, source.relativePath);
    const metadataPath = await this.resolveMetadataPath(id);
    const derivedDocumentPath = await this.resolveDerivedDocumentPath(id);

    await writeFileAtomic(sourcePath.absolutePath, content);
    try {
      await writeJsonAtomic(metadataPath.absolutePath, source);
      await writeFileAtomic(derivedDocumentPath.absolutePath, `${parsedDocument.cdmXml}\n`);
      await this.repository.upsert(source);
      return { source, created: true, inputEncoding: input.inputEncoding };
    } catch (error) {
      await rm(sourcePath.absolutePath, { force: true }).catch(() => undefined);
      await rm(metadataPath.absolutePath, { force: true }).catch(() => undefined);
      await rm(derivedDocumentPath.absolutePath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async synchronizeProjection(): Promise<void> {
    const sources = await this.readMetadataSources();
    await this.repository.synchronize(sources);
  }

  private async readMetadataSources(): Promise<KnowledgeSource[]> {
    const metadataDirectory = await resolveInsideProject(this.projectRoot, "sources/metadata");
    const entries = await readdir(metadataDirectory.absolutePath, { withFileTypes: true });
    const sources: KnowledgeSource[] = [];
    const hashes = new Set<string>();

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".json")) {
        continue;
      }
      const metadataPath = await resolveInsideProject(
        this.projectRoot,
        `sources/metadata/${entry.name}`,
      );
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(metadataPath.absolutePath, "utf8")) as unknown;
      } catch (error) {
        throw new AppError("VALIDATION_ERROR", `资料元数据文件无效：${entry.name}`, {
          cause: error,
        });
      }
      const source = parseKnowledgeSource(parsed, `资料元数据文件无效：${entry.name}`);
      if (source.projectId !== this.projectId || `${source.id}.json` !== entry.name) {
        throw new AppError("VALIDATION_ERROR", `资料元数据与当前项目不匹配：${entry.name}`);
      }
      const content = await this.readSourceContent(source);
      if (
        hashContent(content) !== source.contentHash ||
        Buffer.byteLength(content, "utf8") !== source.size
      ) {
        throw new AppError("VALIDATION_ERROR", `资料内容与元数据哈希不一致：${source.title}`);
      }
      if (hashes.has(source.contentHash)) {
        throw new AppError("MATERIAL_ALREADY_EXISTS", `存在重复的资料元数据：${source.title}`);
      }
      hashes.add(source.contentHash);
      sources.push(source);
    }
    return sources;
  }

  private async readSourceContent(source: KnowledgeSource): Promise<string> {
    const resolved = await resolveInsideProject(this.projectRoot, source.relativePath);
    try {
      return await readStoredUtf8Text(resolved.absolutePath, this.maxImportBytes);
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError("VALIDATION_ERROR", `资料原始文件不存在：${source.title}`, {
        cause: error,
      });
    }
  }

  private async resolveMetadataPath(id: string) {
    return await resolveInsideProject(this.projectRoot, `sources/metadata/${id}.json`);
  }

  private async resolveDerivedDocumentPath(id: string) {
    return await resolveInsideProject(this.projectRoot, `.cleo/derived/documents/${id}.cdm.xml`);
  }
}

async function ensureMaterialDirectories(projectRoot: string): Promise<void> {
  const materials = await resolveInsideProject(projectRoot, "materials");
  const metadata = await resolveInsideProject(projectRoot, "sources/metadata");
  const derivedDocuments = await resolveInsideProject(projectRoot, ".cleo/derived/documents");
  await Promise.all([
    mkdir(materials.absolutePath, { recursive: true }),
    mkdir(metadata.absolutePath, { recursive: true }),
    mkdir(derivedDocuments.absolutePath, { recursive: true }),
  ]);
}

async function readOptionalFile(filePath: string): Promise<string | null> {
  return await readFile(filePath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  });
}

async function readMaterialFile(
  filePath: string,
  requestedEncoding: MaterialInputEncoding | undefined,
  maxImportBytes: number,
) {
  const content = await readFile(filePath);
  if (content.byteLength > maxImportBytes) {
    throw new AppError("VALIDATION_ERROR", "单份资料超过了软件配置允许的大小。");
  }
  return decodeMaterialText(content, requestedEncoding);
}

async function readStoredUtf8Text(filePath: string, maxImportBytes: number): Promise<string> {
  const content = await readFile(filePath);
  if (content.byteLength > maxImportBytes) {
    throw new AppError("VALIDATION_ERROR", "单份资料超过了软件配置允许的大小。");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch (error) {
    throw new AppError("VALIDATION_ERROR", "项目内资料副本必须是有效的 UTF-8 文本。", {
      cause: error,
    });
  }
}

function materialFormatFromPath(filePath: string): KnowledgeSource["format"] {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".txt") {
    return "text";
  }
  if (extension === ".md" || extension === ".markdown") {
    return "markdown";
  }
  throw new AppError("VALIDATION_ERROR", "步骤 5 仅支持 TXT、MD 和 Markdown 文件。");
}

function assertMaterialContent(content: string, maxImportBytes: number): void {
  const size = Buffer.byteLength(content, "utf8");
  if (size === 0) {
    throw new AppError("VALIDATION_ERROR", "资料内容不能为空。");
  }
  if (size > maxImportBytes) {
    throw new AppError("VALIDATION_ERROR", "单份资料超过了软件配置允许的大小。");
  }
}

function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function normalizeTitle(title: string): string {
  const normalized = title.trim();
  if (normalized.length === 0 || normalized.length > 200) {
    throw new AppError("VALIDATION_ERROR", "资料标题长度必须为 1–200 个字符。");
  }
  return normalized;
}

function normalizeOptionalLabel(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const normalized = value.trim();
  return normalized === "" ? null : normalized;
}

function normalizeTags(tags: readonly string[]): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const tag of tags) {
    const value = tag.trim();
    if (value === "") {
      continue;
    }
    if (value.length > 100) {
      throw new AppError("VALIDATION_ERROR", "单个资料标签不能超过 100 个字符。");
    }
    const key = value.toLocaleLowerCase("zh-CN");
    if (!seen.has(key)) {
      seen.add(key);
      normalized.push(value);
    }
  }
  if (normalized.length > 100) {
    throw new AppError("VALIDATION_ERROR", "单份资料不能超过 100 个标签。");
  }
  return normalized;
}

function defaultPastedTitle(): string {
  return `粘贴资料 ${new Date().toLocaleString("zh-CN", { hour12: false })}`;
}

function materialNotFound(id: string): AppError {
  return new AppError("MATERIAL_NOT_FOUND", "找不到指定资料。", { details: { materialId: id } });
}

function parseKnowledgeSource(value: unknown, message = "资料元数据无效。"): KnowledgeSource {
  const parsed = knowledgeSourceSchema.safeParse(value);
  if (!parsed.success) {
    throw new AppError("VALIDATION_ERROR", message, {
      details: {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
    });
  }
  return parsed.data;
}
