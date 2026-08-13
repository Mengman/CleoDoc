import path from "node:path";

export interface DesktopResourcePathContext {
  readonly appPath: string;
  readonly resourcesPath: string;
  readonly isPackaged: boolean;
}

export function resolveDesktopDefaultConfigPath(context: DesktopResourcePathContext): string {
  return context.isPackaged
    ? path.join(context.resourcesPath, "config", "software-default.yaml")
    : path.join(context.appPath, "resources", "config", "software-default.yaml");
}
