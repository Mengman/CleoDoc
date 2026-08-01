import { homedir } from "node:os";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { AppError } from "../../contracts/src/index.js";
import { writeJsonAtomic } from "./atomic-file.js";

const configSchema = z.object({
  schemaVersion: z.literal(1),
  currentProject: z.string().nullable(),
  updatedAt: z.iso.datetime(),
});

export type CliConfig = z.infer<typeof configSchema>;

export class ConfigService {
  readonly homeDirectory: string;
  readonly configPath: string;

  constructor(environment: NodeJS.ProcessEnv = process.env) {
    this.homeDirectory = resolveCleoDocHome(environment);
    this.configPath = path.join(this.homeDirectory, "config.json");
  }

  async read(): Promise<CliConfig> {
    const content = await readFile(this.configPath, "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") {
          return null;
        }
        throw error;
      },
    );
    if (content === null) {
      return { schemaVersion: 1, currentProject: null, updatedAt: new Date(0).toISOString() };
    }
    try {
      return configSchema.parse(JSON.parse(content));
    } catch (error) {
      throw new AppError("CONFIG_ERROR", "CLI 配置文件格式无效。", { cause: error });
    }
  }

  async setCurrentProject(projectRoot: string): Promise<CliConfig> {
    const config: CliConfig = {
      schemaVersion: 1,
      currentProject: path.resolve(projectRoot),
      updatedAt: new Date().toISOString(),
    };
    await mkdir(this.homeDirectory, { recursive: true });
    await writeJsonAtomic(this.configPath, config);
    return config;
  }
}

function resolveCleoDocHome(environment: NodeJS.ProcessEnv): string {
  if (environment.CLEODOC_HOME !== undefined && environment.CLEODOC_HOME.trim() !== "") {
    return path.resolve(environment.CLEODOC_HOME);
  }
  if (process.platform === "win32" && environment.APPDATA !== undefined) {
    return path.join(environment.APPDATA, "CleoDoc");
  }
  if (process.platform === "darwin") {
    return path.join(homedir(), "Library", "Application Support", "CleoDoc");
  }
  return path.join(environment.XDG_CONFIG_HOME ?? path.join(homedir(), ".config"), "cleodoc");
}
