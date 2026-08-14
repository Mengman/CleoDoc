import { ChatService } from "../../../../packages/agent/src/index.js";
import { AppError } from "../../../../packages/contracts/src/index.js";
import { assertOnlyOptions, optionString, type ParsedArguments } from "../arguments.js";
import { chatServiceOptions } from "./chat-settings.js";
import { resolveProjectRoot, type CliCommandContext } from "./command-context.js";
import { printConversationHistory } from "./conversation-ui.js";

export async function runConversationCommand(
  parsed: ParsedArguments,
  context: CliCommandContext,
): Promise<void> {
  const [subcommand, conversationId] = parsed.positionals;
  assertOnlyOptions(parsed, ["project"]);
  const root = await resolveProjectRoot(context, optionString(parsed, "project"));
  const project = await context.projectService.open(root);
  const chat = await ChatService.open(project.root, chatServiceOptions());
  try {
    if (subcommand === "list" && parsed.positionals.length === 1) {
      const conversations = chat.listConversations(project.manifest.id);
      if (conversations.length === 0) context.output.write("尚无聊天记录。\n");
      for (const conversation of conversations) {
        context.output.write(
          `${conversation.id}\t${conversation.updatedAt}\t${conversation.messageCount} 条消息\t${conversation.title ?? "未命名"}\n`,
        );
      }
      return;
    }
    if (subcommand === "show" && conversationId !== undefined && parsed.positionals.length === 2) {
      printConversationHistory(context, chat.getConversationHistory(conversationId));
      return;
    }
    throw new AppError("VALIDATION_ERROR", "用法：cleo conversation <list|show <conversation-id>>");
  } finally {
    await chat.close();
  }
}
