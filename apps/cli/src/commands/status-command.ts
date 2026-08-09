import { AppError } from "../../../../packages/contracts/src/index.js";
import { assertOnlyOptions, optionString, type ParsedArguments } from "../arguments.js";
import { resolveProjectRoot, type CliCommandContext } from "./command-context.js";

export async function runStatusCommand(
  parsed: ParsedArguments,
  context: CliCommandContext,
): Promise<void> {
  assertOnlyOptions(parsed, ["project"]);
  if (parsed.positionals.length !== 0) {
    throw new AppError("VALIDATION_ERROR", "用法：cleo status [--project <directory>]");
  }
  const root = await resolveProjectRoot(context, optionString(parsed, "project"));
  const status = await context.projectService.status(root);
  context.output.write(`项目：${status.manifest.name}\n`);
  context.output.write(`目录：${status.root}\n`);
  context.output.write(`数据库：${status.database}\n`);
  context.output.write(`正文文档：${status.documentCount}\n`);
}
