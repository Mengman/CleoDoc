import { homedir } from "node:os";
import path from "node:path";

export function resolveCleoDocHome(environment: NodeJS.ProcessEnv = process.env): string {
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
