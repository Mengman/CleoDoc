import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, realpath } from "node:fs/promises";
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

type ProjectDatabaseOptions = { busyTimeoutMs: number };

export class ProjectService {
  private activeProject: OpenProject | undefined;
  private activeDatabase: ProjectDatabase | undefined;

  constructor(private readonly databaseOptions: ProjectDatabaseOptions) {}

  get project(): OpenProject {
    if (this.activeProject === undefined) {
      throw new AppError("INTERNAL_ERROR", "当前 ProjectService 未绑定活动项目。");
    }
    return this.activeProject;
  }

  get database(): ProjectDatabase {
    if (this.activeDatabase === undefined) {
      throw new AppError("INTERNAL_ERROR", "当前 ProjectService 未绑定项目数据库。");
    }
    return this.activeDatabase;
  }

  async create(directory: string, name?: string): Promise<OpenProject> {
    // Create a project directory with its manifest and initial storage structure.
    // 1. Resolve the requested directory and reject an existing project or non-empty directory.
    // 2. Create the required fact-source and runtime directories, then persist the manifest.
    // 3. Initialize the project database once so its schema is ready for later use.
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
    const entries = await readdir(canonicalRoot);
    if (entries.length > 0) {
      throw new AppError("PROJECT_DIRECTORY_NOT_EMPTY", "新项目目录必须为空。");
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
    // Open one project session and retain its database until the caller closes this service.
    const project = await ProjectService.readProject(directory);
    if (this.activeProject !== undefined) {
      if (this.activeProject.root === project.root) return this.activeProject;
      throw new AppError("INTERNAL_ERROR", "当前 ProjectService 已打开其他项目。");
    }
    const database = await ProjectDatabase.open(project.root, this.databaseOptions);
    this.activeProject = project;
    this.activeDatabase = database;
    return project;
  }

  static async readProject(directory: string): Promise<OpenProject> {
    // Read and validate one existing project manifest without opening its database.
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
    // Read the project status after checking its database and manuscript list.
    const project = await ProjectService.readProject(directory);
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

  async close(): Promise<void> {
    const database = this.activeDatabase;
    this.activeProject = undefined;
    this.activeDatabase = undefined;
    await database?.close();
  }
}
