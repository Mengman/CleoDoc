import { AppError } from "../../../../packages/contracts/src/index.js";
import { DocumentService } from "../../../../packages/project/src/index.js";
import { assertOnlyOptions, optionString, type ParsedArguments } from "../arguments.js";
import { resolveProjectRoot, type CliCommandContext } from "./command-context.js";
import { printSaved } from "./command-utils.js";

export async function runDocumentCommand(
  parsed: ParsedArguments,
  context: CliCommandContext,
): Promise<void> {
  // Execute direct document listing, reading, creation, or deletion for the active project.
  // 1. Validate the supported document options and resolve the project.
  // 2. Dispatch the requested document subcommand with strict positional validation.
  // 3. Return the resulting document data or a stable validation error.
  const [subcommand, reference] = parsed.positionals;
  assertOnlyOptions(parsed, ["project", "content"]);
  const root = await resolveProjectRoot(context, optionString(parsed, "project"));
  const project = await context.projectService.open(root);
  const documents = new DocumentService(project.root);

  switch (subcommand) {
    case "list": {
      if (parsed.positionals.length !== 1) {
        throw new AppError("VALIDATION_ERROR", "用法：cleo document list");
      }
      const list = await documents.list();
      if (list.length === 0) context.output.write("尚无正文文档。\n");
      for (const document of list) {
        context.output.write(`${document.relativePath}\t${document.size} bytes\n`);
      }
      return;
    }
    case "show": {
      if (reference === undefined || parsed.positionals.length !== 2) {
        throw new AppError("VALIDATION_ERROR", "用法：cleo document show <path>");
      }
      const document = await documents.read(reference);
      context.output.write(`--- ${document.summary.relativePath} ---\n`);
      context.output.write(document.content);
      if (!document.content.endsWith("\n")) context.output.write("\n");
      return;
    }
    case "create": {
      if (reference === undefined || parsed.positionals.length !== 2) {
        throw new AppError(
          "VALIDATION_ERROR",
          "用法：cleo document create <path> [--content <text>]",
        );
      }
      printSaved(context, await documents.save(reference, optionString(parsed, "content") ?? ""));
      return;
    }
    case "delete": {
      if (reference === undefined || parsed.positionals.length !== 2) {
        throw new AppError("VALIDATION_ERROR", "用法：cleo document delete <path>");
      }
      const deleted = await documents.delete(reference);
      context.output.write(`已删除：${deleted.relativePath}\n`);
      return;
    }
    default:
      throw new AppError("VALIDATION_ERROR", "未知 document 子命令。");
  }
}
