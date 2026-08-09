import { ChatService } from "../../../../packages/agent/src/index.js";
import { AppError } from "../../../../packages/contracts/src/index.js";
import { DocumentService } from "../../../../packages/project/src/index.js";
import {
  assertOnlyOptions,
  optionBoolean,
  optionString,
  type ParsedArguments,
} from "../arguments.js";
import { chatServiceOptions } from "./chat-settings.js";
import { resolveProjectRoot, type CliCommandContext } from "./command-context.js";
import { printSaved } from "./command-utils.js";

export async function runDocumentCommand(
  parsed: ParsedArguments,
  context: CliCommandContext,
): Promise<void> {
  const [subcommand, reference] = parsed.positionals;
  assertOnlyOptions(parsed, ["project", "content", "overwrite"]);
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
        context.output.write(`${document.id}\t${document.relativePath}\t${document.size} bytes\n`);
      }
      return;
    }
    case "show": {
      if (reference === undefined || parsed.positionals.length !== 2) {
        throw new AppError("VALIDATION_ERROR", "用法：cleo document show <document-id|path>");
      }
      const document = await documents.read(reference);
      context.output.write(`--- ${document.summary.relativePath} (${document.summary.id}) ---\n`);
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
    case "save-last": {
      if (reference === undefined || parsed.positionals.length !== 2) {
        throw new AppError("VALIDATION_ERROR", "用法：cleo document save-last <path>");
      }
      const chat = await ChatService.open(project.root, chatServiceOptions());
      try {
        printSaved(
          context,
          await chat.saveGeneration(reference, {
            overwrite: optionBoolean(parsed, "overwrite"),
          }),
        );
      } finally {
        await chat.close();
      }
      return;
    }
    case "delete": {
      if (reference === undefined || parsed.positionals.length !== 2) {
        throw new AppError("VALIDATION_ERROR", "用法：cleo document delete <document-id|path>");
      }
      const deleted = await documents.delete(reference);
      context.output.write(`已删除：${deleted.relativePath}\n`);
      return;
    }
    default:
      throw new AppError("VALIDATION_ERROR", "未知 document 子命令。");
  }
}
