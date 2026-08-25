import { readFile } from "node:fs/promises";
import path from "node:path";

import { parseDocument } from "yaml";
import { z } from "zod";

import { resolveCleoDocHome } from "./config-paths.js";
import { writeYamlAtomic } from "./yaml-file.js";

const appStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    currentProject: z.string().nullable(),
    recentDirectory: z.string().nullable().default(null),
    recentProjects: z.array(z.string()).max(10).default([]),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export type AppState = z.infer<typeof appStateSchema>;

export class AppStateService {
  readonly homeDirectory: string;
  readonly statePath: string;

  constructor(environment: NodeJS.ProcessEnv = process.env) {
    this.homeDirectory = resolveCleoDocHome(environment);
    this.statePath = path.join(this.homeDirectory, "state.yaml");
  }

  async read(): Promise<AppState> {
    const content = await readFile(this.statePath, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (content === null) return emptyState();
    const document = parseDocument(content, { uniqueKeys: true });
    if (document.errors.length > 0) return emptyState();
    const parsed = appStateSchema.safeParse(document.toJS({ maxAliasCount: 0 }));
    return parsed.success ? parsed.data : emptyState();
  }

  async setCurrentProject(projectRoot: string): Promise<AppState> {
    // Remember the current project and move it to the front of the recent-project list.
    const currentProject = path.resolve(projectRoot);
    const state = await this.read();
    return this.writeState(
      currentProject,
      path.dirname(currentProject),
      [
        currentProject,
        ...state.recentProjects.filter((project) => project !== currentProject),
      ].slice(0, 10),
    );
  }

  async setRecentDirectory(directory: string): Promise<AppState> {
    const state = await this.read();
    return this.writeState(state.currentProject, path.resolve(directory), state.recentProjects);
  }

  async clearCurrentProject(): Promise<AppState> {
    const state = await this.read();
    return this.writeState(null, state.recentDirectory, state.recentProjects);
  }

  async removeRecentProject(projectRoot: string): Promise<AppState> {
    // Remove one unusable project while preserving all other application state.
    const state = await this.read();
    const currentProject = path.resolve(projectRoot);
    return this.writeState(
      state.currentProject,
      state.recentDirectory,
      state.recentProjects.filter((project) => project !== currentProject),
    );
  }

  async clearRecentProjects(): Promise<AppState> {
    const state = await this.read();
    return this.writeState(state.currentProject, state.recentDirectory, []);
  }

  private async writeState(
    currentProject: string | null,
    recentDirectory: string | null,
    recentProjects: string[],
  ): Promise<AppState> {
    // Persist the complete application state after one focused state transition.
    const state: AppState = {
      schemaVersion: 1,
      currentProject,
      recentDirectory,
      recentProjects,
      updatedAt: new Date().toISOString(),
    };
    await writeYamlAtomic(this.statePath, state);
    return state;
  }
}

function emptyState(): AppState {
  return {
    schemaVersion: 1,
    currentProject: null,
    recentDirectory: null,
    recentProjects: [],
    updatedAt: new Date(0).toISOString(),
  };
}
