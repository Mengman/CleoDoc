import { z } from "zod";

import { AppError } from "../../../../packages/contracts/src/index.js";
import {
  assertOnlyOptions,
  optionString,
  type ParsedArguments,
  validateInput,
} from "../arguments.js";
import type { CliCommandContext } from "./command-context.js";

export async function runInitCommand(
  parsed: ParsedArguments,
  context: CliCommandContext,
): Promise<void> {
  assertOnlyOptions(parsed, ["name"]);
  const inputValue = validateInput(
    z.object({ directory: z.string().min(1), name: z.string().min(1).optional() }),
    { directory: parsed.positionals[0], name: optionString(parsed, "name") },
  );
  if (parsed.positionals.length !== 1) {
    throw new AppError("VALIDATION_ERROR", "用法：cleo init <directory> [--name <作品名>]");
  }
  const project = await context.projectService.create(inputValue.directory, inputValue.name);
  await context.appState.setCurrentProject(project.root);
  context.output.write(`已创建项目：${project.manifest.name}\n`);
  context.output.write(`项目目录：${project.root}\n`);
  context.output.write(`项目 ID：${project.manifest.id}\n`);
}
