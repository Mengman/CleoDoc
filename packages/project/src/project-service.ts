import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import type { ProjectManifest, ProjectStatus } from "../../contracts/src/index.js";
import { AppError, projectManifestSchema } from "../../contracts/src/index.js";
import { ProjectDatabase } from "../../database/src/index.js";
import { writeJsonAtomic } from "./atomic-file.js";
import { DocumentService } from "./document-service.js";

const MANIFEST_NAME = "cleo.project.json";

export interface OpenProject {
  root: string;
  manifest: ProjectManifest;
}

export class ProjectService {
  constructor(private readonly databaseOptions: { busyTimeoutMs: number }) {}

  async create(directory: string, name?: string): Promise<OpenProject> {
    const root = path.resolve(directory);
    await mkdir(root, { recursive: true });
    const canonicalRoot = await realpath(root);
    const manifestPath = path.join(canonicalRoot, MANIFEST_NAME);
    const existing = await readFile(manifestPath, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return null;
      }
      throw error;
    });
    if (existing !== null) {
      throw new AppError("PROJECT_ALREADY_EXISTS", "该目录已经是 CleoDoc 项目。");
    }

    const now = new Date().toISOString();
    const manifest: ProjectManifest = {
      schemaVersion: 1,
      id: randomUUID(),
      name: name?.trim() || path.basename(canonicalRoot).replace(/\.cleo$/i, "") || "未命名作品",
      language: "zh-CN",
      createdAt: now,
      updatedAt: now,
    };
    projectManifestSchema.parse(manifest);

    await Promise.all([
      mkdir(path.join(canonicalRoot, "manuscript"), { recursive: true }),
      mkdir(path.join(canonicalRoot, "materials"), { recursive: true }),
      mkdir(path.join(canonicalRoot, "sources", "metadata"), { recursive: true }),
      mkdir(path.join(canonicalRoot, ".cleo", "blobs"), { recursive: true }),
      mkdir(path.join(canonicalRoot, ".cleo", "models"), { recursive: true }),
      mkdir(path.join(canonicalRoot, ".cleo", "backups"), { recursive: true }),
    ]);
    await writeJsonAtomic(manifestPath, manifest);

    const database = await ProjectDatabase.open(canonicalRoot, this.databaseOptions);
    await database.close();
    return { root: canonicalRoot, manifest };
  }

  async open(directory: string): Promise<OpenProject> {
    const requestedRoot = path.resolve(directory);
    const root = await realpath(requestedRoot).catch((error: unknown) => {
      throw new AppError("PROJECT_NOT_FOUND", "项目目录不存在。", { cause: error });
    });
    const manifestPath = path.join(root, MANIFEST_NAME);
    const content = await readFile(manifestPath, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        throw new AppError("PROJECT_NOT_FOUND", "目录中没有 cleo.project.json。", {
          details: { directory: requestedRoot },
        });
      }
      throw error;
    });

    try {
      return { root, manifest: projectManifestSchema.parse(JSON.parse(content)) };
    } catch (error) {
      throw new AppError("VALIDATION_ERROR", "项目清单格式无效。", { cause: error });
    }
  }

  async status(directory: string): Promise<ProjectStatus> {
    const project = await this.open(directory);
    const database = await ProjectDatabase.open(project.root, this.databaseOptions);
    const healthy = database.quickCheck();
    await database.close();
    const documents = await new DocumentService(project.root).list();
    return {
      root: project.root,
      manifest: project.manifest,
      database: healthy ? "ok" : "corrupt",
      documentCount: documents.length,
    };
  }
}
