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
    const state: AppState = {
      schemaVersion: 1,
      currentProject: path.resolve(projectRoot),
      updatedAt: new Date().toISOString(),
    };
    await writeYamlAtomic(this.statePath, state);
    return state;
  }
}

function emptyState(): AppState {
  return { schemaVersion: 1, currentProject: null, updatedAt: new Date(0).toISOString() };
}
