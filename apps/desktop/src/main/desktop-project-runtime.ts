import { randomUUID } from "node:crypto";

import { AppStateService } from "../../../../packages/config/src/index.js";
import {
  ChatService,
  ConversationHistoryService,
  type ChatServiceOptions,
} from "../../../../packages/agent/src/index.js";
import {
  AppError,
  asAppError,
  type ModelEvent,
  type ModelProvider,
} from "../../../../packages/contracts/src/index.js";
import { ProjectDatabase } from "../../../../packages/database/src/index.js";
import {
  DocumentService,
  type OpenProject,
  ProjectService,
} from "../../../../packages/project/src/index.js";
import { desktopProjectStateSchema, type DesktopProjectState } from "../shared/desktop-api.js";

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

interface ActiveProject {
  readonly project: OpenProject;
  readonly database: ProjectDatabase;
  readonly documentCount: number;
  readonly controller: AbortController;
  readonly tasks: Map<string, Promise<unknown>>;
  readonly conversations: ConversationHistoryService;
  readonly chat: ChatService;
}

export interface DesktopProjectRuntimeOptions {
  readonly busyTimeoutMs: number;
  readonly appStateService?: AppStateService;
  readonly chat: Omit<ChatServiceOptions, "database">;
}

export class DesktopProjectRuntime {
  private readonly appStateService: AppStateService;
  private readonly projectService: ProjectService;
  private activeProject: ActiveProject | undefined;
  private operationTail: Promise<void> = Promise.resolve();

  constructor(private readonly options: DesktopProjectRuntimeOptions) {
    this.appStateService = options.appStateService ?? new AppStateService();
    this.projectService = new ProjectService({ busyTimeoutMs: options.busyTimeoutMs });
  }

  getState(): DesktopProjectState {
    // Build the renderer-safe state projection for the current project session.
    const active = this.activeProject;
    if (active === undefined) return { status: "closed" };

    return desktopProjectStateSchema.parse({
      status: "open",
      project: {
        id: active.project.manifest.id,
        name: active.project.manifest.name,
        language: active.project.manifest.language,
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
        await this.openActiveProject(state.currentProject);
      } catch (error) {
        await this.closeActiveProject();
        throw error;
      }
      return this.getState();
    });
  }

  async open(directory: string): Promise<DesktopProjectState> {
    // Replace the active project with the project selected by the user.
    return this.enqueue(async () => {
      // Close the old session before opening the new one and leave no stale session on failure.
      await this.closeActiveProject();
      try {
        await this.openActiveProject(directory);
        return this.getState();
      } catch (error) {
        await this.closeActiveProject();
        throw error;
      }
    });
  }

  async close(): Promise<DesktopProjectState> {
    return this.enqueue(async () => {
      await this.closeActiveProject();
      return this.getState();
    });
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
        projectId: active.project.manifest.id,
        projectRoot: active.project.root,
        database: active.database,
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

  getConversationModel(conversationId: string): { providerId: string; model: string } {
    const conversation = this.getRecentConversationHistory(conversationId).conversation;
    return { providerId: conversation.providerId, model: conversation.model };
  }

  async sendMessage(input: {
    readonly conversationId?: string;
    readonly prompt: string;
    readonly provider: ModelProvider;
    readonly model: string;
    readonly contextBudgetPolicy?: Parameters<ChatService["send"]>[0]["contextBudgetPolicy"];
    readonly onEvent?: (event: ModelEvent) => void;
  }) {
    // Send through the active project's chat service and return its refreshed visible messages.
    const active = this.requireActiveProject();
    const task = this.startTask(async ({ projectId, signal }) => {
      const result = await active.chat.send({ ...input, projectId, signal });
      return active.conversations.getRecentHistory(result.conversationId, 20);
    });
    return task.promise;
  }

  private async openActiveProject(directory: string): Promise<void> {
    // Open and validate all resources required by a new active project session.
    // 1. Resolve the project manifest and open its SQLite database.
    // 2. Verify database integrity and calculate the initial document count.
    // 3. Persist the selected project before publishing the new in-memory session.
    // 4. Close the database when any initialization step fails.
    const project = await this.projectService.open(directory);
    const database = await ProjectDatabase.open(project.root, {
      busyTimeoutMs: this.options.busyTimeoutMs,
    });

    try {
      if (!database.quickCheck()) {
        throw new AppError("DATABASE_ERROR", "项目数据库完整性检查失败。");
      }
      const documentCount = (await new DocumentService(project.root).list()).length;
      const chat = await ChatService.usingDatabase(project.root, database, {
        database: { busyTimeoutMs: this.options.busyTimeoutMs },
        ...this.options.chat,
      });
      const activeProject: ActiveProject = {
        project,
        database,
        documentCount,
        controller: new AbortController(),
        tasks: new Map(),
        conversations: new ConversationHistoryService(database, project.manifest.id),
        chat,
      };
      await this.appStateService.setCurrentProject(project.root);
      this.activeProject = activeProject;
    } catch (error) {
      await database.close();
      throw error;
    }
  }

  private async closeActiveProject(clearRememberedProject = true): Promise<void> {
    // Cancel project tasks, release the database, and optionally forget the project path.
    const active = this.activeProject;
    this.activeProject = undefined;

    if (active !== undefined) {
      active.controller.abort(new AppError("GENERATION_CANCELLED", "项目已关闭。"));
      await Promise.allSettled(active.tasks.values());
      await active.chat.close();
      await active.database.close();
    }
    if (clearRememberedProject) await this.appStateService.clearCurrentProject();
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
