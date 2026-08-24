import { randomUUID } from "node:crypto";
import path from "node:path";

import { AppStateService } from "../../../../packages/config/src/index.js";
import {
  ChatService,
  ConversationHistoryService,
  type ChatServiceOptions,
} from "../../../../packages/agent/src/index.js";
import {
  AppError,
  asAppError,
  type ModelMessageSender,
} from "../../../../packages/contracts/src/index.js";
import type { ProjectDatabase } from "../../../../packages/database/src/index.js";
import { MaterialService } from "../../../../packages/knowledge/src/material-service.js";
import type { MaterialServiceOptions } from "../../../../packages/knowledge/src/material-types.js";
import { DocumentService, ProjectService } from "../../../../packages/project/src/index.js";
import {
  desktopProjectStateSchema,
  type DesktopProjectState,
  type ManuscriptDocumentsChangedEvent,
} from "../shared/desktop-api.js";

export interface DesktopProjectTaskContext {
  readonly projectId: string;
  readonly projectRoot: string;
  readonly database: ProjectDatabase;
  readonly signal: AbortSignal;
}

export interface DesktopProjectTask<T> {
  readonly id: string;
  readonly promise: Promise<T>;
  readonly cancel: () => void;
}

export interface DesktopProjectChatContext {
  readonly projectId: string;
  readonly signal: AbortSignal;
  readonly chat: Pick<ChatService, "send">;
  readonly conversations: Pick<ConversationHistoryService, "getConversation" | "getRecentHistory">;
}

export interface DesktopMaterialImportTaskResult {
  readonly imported: Awaited<ReturnType<MaterialService["addFile"]>>;
  readonly embeddingFailure: { readonly code: string; readonly message: string } | null;
}

interface ActiveProject {
  readonly projectService: ProjectService;
  readonly materials: MaterialService;
  readonly documents: DocumentService;
  readonly documentCount: number;
  readonly controller: AbortController;
  readonly tasks: Map<string, Promise<unknown>>;
  readonly conversations: ConversationHistoryService;
  readonly chat: ChatService;
  readonly stopManuscriptWatcher: () => void;
}

export interface DesktopProjectRuntimeOptions {
  readonly busyTimeoutMs: number;
  readonly appStateService?: AppStateService;
  readonly chat: Omit<ChatServiceOptions, "database">;
  readonly materials: MaterialServiceOptions;
  readonly provider: ModelMessageSender;
}

export class DesktopProjectRuntime {
  private readonly appStateService: AppStateService;
  private activeProject: ActiveProject | undefined;
  private operationTail: Promise<void> = Promise.resolve();
  private manuscriptDocumentsChangedListener:
    ((event: ManuscriptDocumentsChangedEvent) => void) | undefined;

  constructor(private readonly options: DesktopProjectRuntimeOptions) {
    this.appStateService = options.appStateService ?? new AppStateService();
  }

  getState(): DesktopProjectState {
    // Build the renderer-safe state projection for the current project session.
    const active = this.activeProject;
    if (active === undefined) return { status: "closed" };

    return desktopProjectStateSchema.parse({
      status: "open",
      project: {
        id: active.projectService.project.manifest.id,
        name: active.projectService.project.manifest.name,
        folderName: path.basename(active.projectService.project.root),
        language: active.projectService.project.manifest.language,
        documentCount: active.documentCount,
        database: "ok",
      },
    });
  }

  async restorePreviousProject(): Promise<DesktopProjectState> {
    // Restore the remembered project inside the serialized lifecycle queue.
    return this.enqueue(async () => {
      // Open the remembered project or clear stale state when restoration fails.
      const state = await this.appStateService.read();
      if (state.currentProject === null) return this.getState();

      try {
        await this.replaceActiveProject(state.currentProject);
      } catch (error) {
        await this.closeActiveProject();
        throw error;
      }
      return this.getState();
    });
  }

  async open(directory: string): Promise<DesktopProjectState> {
    // Replace the active project only after the selected project has opened successfully.
    return this.enqueue(async () => {
      return await this.replaceActiveProject(directory);
    });
  }

  async create(directory: string): Promise<DesktopProjectState> {
    // Create a new project without disturbing the current session when creation is rejected.
    return this.enqueue(async () => {
      const projectService = new ProjectService({ busyTimeoutMs: this.options.busyTimeoutMs });
      const project = await projectService.create(directory);
      return await this.replaceActiveProject(project.root);
    });
  }

  async close(): Promise<DesktopProjectState> {
    return this.enqueue(async () => {
      await this.closeActiveProject();
      return this.getState();
    });
  }

  async getRecentDirectory(): Promise<string | null> {
    return (await this.appStateService.read()).recentDirectory;
  }

  async setRecentDirectory(directory: string): Promise<void> {
    await this.appStateService.setRecentDirectory(directory);
  }

  async getRecentProjects(): Promise<readonly string[]> {
    return (await this.appStateService.read()).recentProjects;
  }

  async removeRecentProject(projectRoot: string): Promise<void> {
    await this.appStateService.removeRecentProject(projectRoot);
  }

  async clearRecentProjects(): Promise<void> {
    await this.appStateService.clearRecentProjects();
  }

  startTask<T>(
    operation: (context: DesktopProjectTaskContext) => Promise<T>,
  ): DesktopProjectTask<T> {
    // Start a cancellable task that is strictly bound to the active project session.
    // 1. Require an active project and create a task-scoped cancellation controller.
    // 2. Forward project shutdown cancellation and provide only the current project context.
    // 3. Track the promise until settlement and return a caller-controlled cancel handle.
    const active = this.activeProject;
    if (active === undefined) {
      throw new AppError("PROJECT_NOT_FOUND", "请先打开一个 CleoDoc 项目。");
    }

    const id = randomUUID();
    const controller = new AbortController();
    const abortForProjectClose = (): void => controller.abort(active.controller.signal.reason);
    active.controller.signal.addEventListener("abort", abortForProjectClose, { once: true });

    const promise = Promise.resolve().then(() =>
      operation({
        projectId: active.projectService.project.manifest.id,
        projectRoot: active.projectService.project.root,
        database: active.projectService.database,
        signal: controller.signal,
      }),
    );
    active.tasks.set(id, promise);
    const cleanUp = (): void => {
      active.controller.signal.removeEventListener("abort", abortForProjectClose);
      active.tasks.delete(id);
    };
    void promise.then(cleanUp, cleanUp);

    return {
      id,
      promise,
      cancel: () => controller.abort(new AppError("GENERATION_CANCELLED", "操作已取消。")),
    };
  }

  async dispose(): Promise<void> {
    await this.enqueue(async () => this.closeActiveProject(false));
  }

  listConversations() {
    return this.requireActiveProject().conversations.listConversations();
  }

  getRecentConversationHistory(conversationId: string) {
    return this.requireActiveProject().conversations.getRecentHistory(conversationId, 20);
  }

  listManuscriptDocuments() {
    return this.requireActiveProject().documents.listReadableDocumentPaths();
  }

  onManuscriptDocumentsChanged(
    listener: (event: ManuscriptDocumentsChangedEvent) => void,
  ): () => void {
    // Register the single-window manuscript listener and return its disposer.
    this.manuscriptDocumentsChangedListener = listener;
    return () => {
      if (this.manuscriptDocumentsChangedListener === listener) {
        this.manuscriptDocumentsChangedListener = undefined;
      }
    };
  }

  listMaterials() {
    return this.requireActiveProject().materials.list();
  }

  readMaterial(title: string) {
    return this.requireActiveProject().materials.readByTitle(title);
  }

  async importMaterial(filePath: string): Promise<DesktopMaterialImportTaskResult> {
    // Import and index one chosen file through the current project's material service.
    // 1. Persist the validated source and create its document, chunk, and FTS projections.
    // 2. Generate pending embeddings only for a newly created source after those facts are ready.
    // 3. Preserve the imported source when a recoverable embedding failure leaves work pending.
    const active = this.requireActiveProject();
    const task = this.startTask(async ({ signal }) => {
      const imported = await active.materials.addFile(filePath);
      if (!imported.created) return { imported, embeddingFailure: null };
      const embedding = await active.materials.embedIndex({ signal, continueOnError: true });
      const failedModel = embedding.models.find((model) => model.errorCode !== null);
      return {
        imported,
        embeddingFailure:
          failedModel === undefined
            ? null
            : {
                code: failedModel.errorCode ?? "EMBEDDING_GENERATION_FAILED",
                message: failedModel.errorMessage ?? "无法生成资料 Embedding。",
              },
      };
    });
    return await task.promise;
  }

  async renameMaterial(title: string, newTitle: string) {
    // Rename a current-project material using its unique user-visible title.
    const active = this.requireActiveProject();
    const task = this.startTask(async () => {
      const current = (await active.materials.list()).find((material) => material.title === title);
      if (current === undefined) {
        throw new AppError("MATERIAL_NOT_FOUND", `找不到资料：${title}`);
      }
      return await active.materials.rename(current.id, newTitle);
    });
    return await task.promise;
  }

  async deleteMaterial(title: string) {
    // Delete one current-project material selected by its unique user-visible title.
    const active = this.requireActiveProject();
    const task = this.startTask(async () => {
      const current = (await active.materials.list()).find((material) => material.title === title);
      if (current === undefined) {
        throw new AppError("MATERIAL_NOT_FOUND", `找不到资料：${title}`);
      }
      return await active.materials.remove(current.id);
    });
    return await task.promise;
  }

  readManuscriptDocument(relativePath: string) {
    return this.requireActiveProject().documents.readReadableDocument(relativePath);
  }

  runChatTask<T>(operation: (context: DesktopProjectChatContext) => Promise<T>): Promise<T> {
    // Run one chat use case against services owned by the current project session.
    const active = this.requireActiveProject();
    const task = this.startTask(async ({ projectId, signal }) => {
      return operation({
        projectId,
        signal,
        chat: active.chat,
        conversations: active.conversations,
      });
    });
    return task.promise;
  }

  private async replaceActiveProject(directory: string): Promise<DesktopProjectState> {
    // Replace the live project only after the candidate session and persisted state are ready.
    // 1. Open and validate the candidate without changing the current project.
    // 2. Persist the candidate as current before publishing it as the active session.
    // 3. Release the previous session only after the replacement can be used.
    const next = await this.createActiveProject(directory);
    try {
      await this.appStateService.setCurrentProject(next.projectService.project.root);
    } catch (error) {
      await this.releaseActiveProject(next);
      throw error;
    }
    const previous = this.activeProject;
    this.activeProject = next;
    await this.releaseActiveProject(previous);
    return this.getState();
  }

  private async createActiveProject(directory: string): Promise<ActiveProject> {
    // Open and validate all resources required by a new active project session.
    // 1. Resolve the project manifest and open its SQLite database.
    // 2. Verify database integrity and load the initial manuscript path snapshot.
    // 3. Open chat resources, start the project-scoped watcher, and assemble a candidate session.
    // 4. Stop partial resources when any initialization step fails.
    const projectService = new ProjectService({ busyTimeoutMs: this.options.busyTimeoutMs });
    const project = await projectService.open(directory);
    const controller = new AbortController();
    let stopManuscriptWatcher = (): void => undefined;
    let materials: MaterialService | undefined;
    try {
      if (!projectService.database.quickCheck()) {
        throw new AppError("DATABASE_ERROR", "项目数据库完整性检查失败。");
      }
      const documents = new DocumentService(project.root);
      materials = await MaterialService.open(projectService, this.options.materials);
      const [projectDocuments, readableDocumentPaths] = await Promise.all([
        documents.list(),
        documents.listReadableDocumentPaths(),
      ]);
      const documentCount = projectDocuments.length;
      const chat = await ChatService.open(
        projectService,
        { database: { busyTimeoutMs: this.options.busyTimeoutMs }, ...this.options.chat },
        { provider: this.options.provider },
      );
      let watcherError: unknown;
      try {
        stopManuscriptWatcher = await documents.watchReadableDocumentPaths(
          readableDocumentPaths,
          (paths) => {
            if (controller.signal.aborted) return;
            this.manuscriptDocumentsChangedListener?.({
              outcome: "success",
              documents: [...paths],
            });
          },
          (error) => {
            if (controller.signal.aborted) return;
            this.manuscriptDocumentsChangedListener?.({
              outcome: "error",
              error: toDesktopOperationError(error),
            });
          },
        );
      } catch (error) {
        watcherError = error;
      }
      const activeProject: ActiveProject = {
        projectService,
        materials,
        documents,
        documentCount,
        controller,
        tasks: new Map(),
        conversations: new ConversationHistoryService(projectService.database, project.manifest.id),
        chat,
        stopManuscriptWatcher,
      };
      if (watcherError !== undefined) {
        this.manuscriptDocumentsChangedListener?.({
          outcome: "error",
          error: toDesktopOperationError(watcherError),
        });
      }
      return activeProject;
    } catch (error) {
      controller.abort();
      stopManuscriptWatcher();
      await materials?.close().catch(() => undefined);
      await projectService.close();
      throw error;
    }
  }

  private async closeActiveProject(clearRememberedProject = true): Promise<void> {
    // Cancel project tasks, release the database, and optionally forget the project path.
    const active = this.activeProject;
    this.activeProject = undefined;

    await this.releaseActiveProject(active);
    if (clearRememberedProject) await this.appStateService.clearCurrentProject();
  }

  private async releaseActiveProject(active: ActiveProject | undefined): Promise<void> {
    // Cancel project work and release all resources owned by one project session.
    if (active === undefined) return;
    active.controller.abort(new AppError("GENERATION_CANCELLED", "项目已关闭。"));
    active.stopManuscriptWatcher();
    await Promise.allSettled(active.tasks.values());
    await active.chat.close();
    await active.materials.close();
    await active.projectService.close();
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    // Serialize project lifecycle mutations while allowing later operations after a failure.
    const pending = this.operationTail.then(operation, operation);
    this.operationTail = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  private requireActiveProject(): ActiveProject {
    if (this.activeProject === undefined) {
      throw new AppError("PROJECT_NOT_FOUND", "请先打开一个 CleoDoc 项目。");
    }
    return this.activeProject;
  }
}

export function toDesktopOperationError(error: unknown): { code: string; message: string } {
  const appError = asAppError(error);
  return { code: appError.code, message: appError.message };
}
