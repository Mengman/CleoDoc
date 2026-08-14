import { ChatService } from "../../../../packages/agent/src/index.js";
import { getSoftwareConfig } from "../../../../packages/config/src/index.js";
import { AppError } from "../../../../packages/contracts/src/index.js";
import { KnowledgeToolService } from "../../../../packages/knowledge/src/index.js";
import { DocumentService } from "../../../../packages/project/src/index.js";
import {
  assertOnlyOptions,
  optionBoolean,
  optionString,
  type ParsedArguments,
} from "../arguments.js";
import { LlmDebugFileLogger } from "../debug-log.js";
import { chatServiceOptions, providerServiceFromArguments } from "./chat-settings.js";
import { resolveProjectRoot, type CliCommandContext } from "./command-context.js";
import { runInteractiveChat } from "./interactive-chat.js";
import { createMaterialServiceOptions } from "./material-command.js";
import { generateOnce } from "./send-chat-message.js";

export async function runChatCommand(
  parsed: ParsedArguments,
  context: CliCommandContext,
): Promise<void> {
  // Run single-turn or interactive chat with the selected project and provider configuration.
  // 1. Validate CLI arguments and resolve the active project and model.
  // 2. Open the knowledge, chat, and optional debug services.
  // 3. Select a new, explicit, or interactive conversation flow.
  // 4. Close every opened service in reverse ownership order.
  assertOnlyOptions(parsed, [
    "project",
    "provider",
    "model",
    "base-url",
    "connect-timeout-ms",
    "stream-idle-timeout-ms",
    "generation-timeout-ms",
    "context-window-tokens",
    "max-output-tokens",
    "debug",
    "conversation",
    "new",
    "prompt",
  ]);
  if (parsed.positionals.length !== 0) {
    throw new AppError("VALIDATION_ERROR", "chat 不接受位置参数，请使用 --prompt。");
  }
  const config = getSoftwareConfig();
  const root = await resolveProjectRoot(context, optionString(parsed, "project"));
  const project = await context.projectService.open(root);
  const providerId =
    optionString(parsed, "provider") ?? config.llm.selectedProvider ?? "openai-compatible";
  const model =
    optionString(parsed, "model") ??
    process.env.CLEODOC_MODEL ??
    config.llm.selectedModel ??
    undefined;
  if (!model) {
    throw new AppError("VALIDATION_ERROR", "请使用 --model 或 CLEODOC_MODEL 指定模型。");
  }
  const provider = providerServiceFromArguments(providerId, model, parsed);
  const debug = parsed.options.has("debug") ? optionBoolean(parsed, "debug") : config.debug.enabled;
  const knowledge = await KnowledgeToolService.open(project.root, createMaterialServiceOptions());
  const chat = await ChatService.open(project.root, chatServiceOptions(), {
    knowledge,
    provider,
  }).catch(async (error: unknown) => {
    await knowledge.close();
    throw error;
  });
  const debugLogger = debug ? await LlmDebugFileLogger.create(project.root) : undefined;
  const onDebugEvent = debugLogger?.onEvent;
  if (debugLogger !== undefined) {
    context.output.write(`Debug 日志：${debugLogger.filePath}\n`);
    context.output.write("日志可能包含作品或资料；鉴权 Header 已脱敏。\n");
  }
  try {
    const explicitConversationId = optionString(parsed, "conversation");
    const startNew = optionBoolean(parsed, "new");
    if (explicitConversationId !== undefined && startNew) {
      throw new AppError("VALIDATION_ERROR", "--conversation 和 --new 不能同时使用。");
    }
    const initialConversationId = startNew ? undefined : explicitConversationId;
    const prompt = optionString(parsed, "prompt");
    if (prompt !== undefined) {
      await runSinglePrompt(context, chat, {
        projectId: project.manifest.id,
        prompt,
        conversationId: initialConversationId,
        ...(onDebugEvent === undefined ? {} : { onDebugEvent }),
      });
      return;
    }
    await runInteractiveChat(context, chat, {
      projectId: project.manifest.id,
      provider,
      initialConversationId,
      documents: new DocumentService(project.root),
      ...(onDebugEvent === undefined ? {} : { onDebugEvent }),
    });
  } finally {
    try {
      await chat.close();
    } finally {
      try {
        await knowledge.close();
      } finally {
        await debugLogger?.close();
      }
    }
  }
}

async function runSinglePrompt(
  context: CliCommandContext,
  chat: ChatService,
  options: Parameters<typeof generateOnce>[2],
): Promise<void> {
  const result = await generateOnce(context, chat, options);
  const budget = await chat.getContextStatus(result.conversationId);
  if (budget.softLimitReached) {
    context.output.write("正在进行上下文压缩……\n");
    await chat.compactConversation({
      conversationId: result.conversationId,
      trigger: "automatic",
      signal: new AbortController().signal,
      ...(options.onDebugEvent === undefined ? {} : { onDebugEvent: options.onDebugEvent }),
    });
    context.output.write("上下文压缩完成。\n");
  }
}
