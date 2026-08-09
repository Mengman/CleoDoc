import type { ChatService } from "../../../../packages/agent/src/index.js";
import { asAppError } from "../../../../packages/contracts/src/index.js";
import type { DocumentService } from "../../../../packages/project/src/index.js";
import type { Interface } from "node:readline/promises";
import type { CliCommandContext } from "./command-context.js";
import { printSaved } from "./command-utils.js";

export async function printDocuments(
  context: CliCommandContext,
  documents: DocumentService,
): Promise<void> {
  const list = await documents.list();
  if (list.length === 0) context.output.write("尚无正文文档。\n");
  for (const document of list) context.output.write(`${document.id}\t${document.relativePath}\n`);
}

export async function saveInteractively(
  context: CliCommandContext,
  chat: ChatService,
  readline: Interface,
  path: string,
): Promise<void> {
  try {
    printSaved(context, await chat.saveGeneration(path));
  } catch (error) {
    const appError = asAppError(error);
    if (appError.code !== "DOCUMENT_ALREADY_EXISTS") throw appError;
    const answer = (await readline.question("文档已存在，确认覆盖？[y/N] ")).trim().toLowerCase();
    if (answer === "y" || answer === "yes") {
      printSaved(context, await chat.saveGeneration(path, { overwrite: true }));
    } else {
      context.output.write("已取消保存。\n");
    }
  }
}
