import type { DocumentService } from "../../../../packages/project/src/index.js";
import type { CliCommandContext } from "./command-context.js";

export async function printDocuments(
  context: CliCommandContext,
  documents: DocumentService,
): Promise<void> {
  const list = await documents.list();
  if (list.length === 0) context.output.write("尚无正文文档。\n");
  for (const document of list) context.output.write(`${document.id}\t${document.relativePath}\n`);
}
