import type { ReadStream, WriteStream } from "node:tty";

import type { AppStateService } from "../../../../packages/config/src/index.js";
import { AppError } from "../../../../packages/contracts/src/index.js";
import type { ProjectService } from "../../../../packages/project/src/index.js";

export interface CliCommandContext {
  readonly appState: AppStateService;
  readonly projectService: ProjectService;
  readonly input: ReadStream;
  readonly output: WriteStream;
}

export async function resolveProjectRoot(
  context: CliCommandContext,
  explicitProject: string | undefined,
): Promise<string> {
  if (explicitProject !== undefined) {
    return (await context.projectService.open(explicitProject)).root;
  }
  const state = await context.appState.read();
  if (state.currentProject === null) {
    throw new AppError("PROJECT_NOT_FOUND", "尚未打开项目，请先运行 cleo open <directory>。");
  }
  return (await context.projectService.open(state.currentProject)).root;
}
