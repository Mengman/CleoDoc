import { getSoftwareConfig } from "../../../../packages/config/src/index.js";
import { MaterialService } from "../../../../packages/knowledge/src/index.js";
import { resolveProjectRoot, type CliCommandContext } from "./command-context.js";
import { createMaterialServiceOptions } from "./material-command.js";
import type { RagCommandDependencies } from "./rag-command-types.js";

export function createRagCommandDependencies(context: CliCommandContext): RagCommandDependencies {
  return {
    output: context.output,
    defaultDebug: getSoftwareConfig().debug.enabled,
    resolveProjectRoot: async (explicitProject) =>
      await resolveProjectRoot(context, explicitProject),
    openMaterials: async (projectRoot) => {
      await context.projectService.open(projectRoot);
      return await MaterialService.open(
        context.projectService,
        createMaterialServiceOptions(),
      ).catch(async (error: unknown) => {
        await context.projectService.close();
        throw error;
      });
    },
    closeProject: async () => await context.projectService.close(),
  };
}
