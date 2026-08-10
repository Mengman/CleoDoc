import type { MaterialService } from "../../../../packages/knowledge/src/index.js";

interface CommandOutput {
  write(content: string): unknown;
}

export interface RagCommandDependencies {
  readonly output: CommandOutput;
  readonly defaultDebug: boolean;
  readonly resolveProjectRoot: (explicitProject: string | undefined) => Promise<string>;
  readonly openMaterials: (projectRoot: string) => Promise<RagMaterialService>;
}

export type RagMaterialService = Pick<
  MaterialService,
  | "close"
  | "embedIndex"
  | "getIndexStatus"
  | "rebuildFts"
  | "rebuildIndex"
  | "search"
  | "searchHybrid"
  | "searchSemantic"
>;
