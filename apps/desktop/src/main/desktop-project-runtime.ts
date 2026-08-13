import { randomUUID } from "node:crypto";

import { AppStateService } from "../../../../packages/config/src/index.js";
import { AppError, asAppError } from "../../../../packages/contracts/src/index.js";
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
}

export interface DesktopProjectRuntimeOptions {
  readonly busyTimeoutMs: number;
  readonly appStateService?: AppStateService;
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
    return this.enqueue(async () => {
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
    return this.enqueue(async () => {
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

  private async openActiveProject(directory: string): Promise<void> {
    const project = await this.projectService.open(directory);
    const database = await ProjectDatabase.open(project.root, {
      busyTimeoutMs: this.options.busyTimeoutMs,
    });

    try {
      if (!database.quickCheck()) {
        throw new AppError("DATABASE_ERROR", "项目数据库完整性检查失败。");
      }
      const documentCount = (await new DocumentService(project.root).list()).length;
      const activeProject: ActiveProject = {
        project,
        database,
        documentCount,
        controller: new AbortController(),
        tasks: new Map(),
      };
      await this.appStateService.setCurrentProject(project.root);
      this.activeProject = activeProject;
    } catch (error) {
      await database.close();
      throw error;
    }
  }

  private async closeActiveProject(clearRememberedProject = true): Promise<void> {
    const active = this.activeProject;
    this.activeProject = undefined;

    if (active !== undefined) {
      active.controller.abort(new AppError("GENERATION_CANCELLED", "项目已关闭。"));
      await Promise.allSettled(active.tasks.values());
      await active.database.close();
    }
    if (clearRememberedProject) await this.appStateService.clearCurrentProject();
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.operationTail.then(operation, operation);
    this.operationTail = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }
}

export function toDesktopOperationError(error: unknown): { code: string; message: string } {
  const appError = asAppError(error);
  return { code: appError.code, message: appError.message };
}
