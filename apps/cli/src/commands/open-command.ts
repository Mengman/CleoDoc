import { AppError } from "../../../../packages/contracts/src/index.js";
import { assertOnlyOptions, type ParsedArguments } from "../arguments.js";
import type { CliCommandContext } from "./command-context.js";

export async function runOpenCommand(
  parsed: ParsedArguments,
  context: CliCommandContext,
): Promise<void> {
  assertOnlyOptions(parsed, []);
  if (parsed.positionals.length !== 1 || parsed.positionals[0] === undefined) {
    throw new AppError("VALIDATION_ERROR", "用法：cleo open <directory>");
  }
  const project = await context.projectService.open(parsed.positionals[0]);
  await context.appState.setCurrentProject(project.root);
  context.output.write(`当前项目：${project.manifest.name}\n${project.root}\n`);
}
