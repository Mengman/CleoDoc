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
import {
  chatServiceOptions,
  providerFromArguments,
  resolveContextBudgetPolicy,
} from "./chat-settings.js";
import { resolveProjectRoot, type CliCommandContext } from "./command-context.js";
import { printSaved } from "./command-utils.js";
import { runInteractiveChat } from "./interactive-chat.js";
import { createMaterialServiceOptions } from "./material-command.js";
import { generateOnce } from "./send-chat-message.js";

export async function runChatCommand(
  parsed: ParsedArguments,
  context: CliCommandContext,
): Promise<void> {
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
    "save",
    "overwrite",
  ]);
  if (parsed.positionals.length !== 0) {
    throw new AppError("VALIDATION_ERROR", "chat 不接受位置参数，请使用 --prompt。");
  }
  const config = getSoftwareConfig();
  const root = await resolveProjectRoot(context, optionString(parsed, "project"));
  const project = await context.projectService.open(root);
  const providerId =
    optionString(parsed, "provider") ?? config.llm.selectedProvider ?? "openai-compatible";
  const provider = providerFromArguments(providerId, parsed);
  const model =
    optionString(parsed, "model") ??
    process.env.CLEODOC_MODEL ??
    config.llm.selectedModel ??
    undefined;
  if (!model) {
    throw new AppError("VALIDATION_ERROR", "请使用 --model 或 CLEODOC_MODEL 指定模型。");
  }
  const debug = parsed.options.has("debug") ? optionBoolean(parsed, "debug") : config.debug.enabled;
  const contextBudgetPolicy = resolveContextBudgetPolicy(providerId, model, parsed);
  const knowledge = await KnowledgeToolService.open(project.root, createMaterialServiceOptions());
  const chat = await ChatService.open(project.root, chatServiceOptions(), { knowledge }).catch(
    async (error: unknown) => {
      await knowledge.close();
      throw error;
    },
  );
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
        provider,
        model,
        prompt,
        conversationId: initialConversationId,
        contextBudgetPolicy,
        parsed,
        ...(onDebugEvent === undefined ? {} : { onDebugEvent }),
      });
      return;
    }
    if (parsed.options.has("save") || parsed.options.has("overwrite")) {
      throw new AppError("VALIDATION_ERROR", "--save 和 --overwrite 仅用于 --prompt 单轮模式。");
    }
    await runInteractiveChat(context, chat, {
      projectId: project.manifest.id,
      provider,
      model,
      initialConversationId,
      createProvider: (selectedProviderId) => providerFromArguments(selectedProviderId, parsed),
      documents: new DocumentService(project.root),
      contextBudgetPolicy,
      createContextBudgetPolicy: (selectedProviderId, selectedModel) =>
        resolveContextBudgetPolicy(selectedProviderId, selectedModel, parsed),
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
  options: Parameters<typeof generateOnce>[2] & {
    readonly parsed: ParsedArguments;
  },
): Promise<void> {
  const { parsed, ...generationInput } = options;
  const result = await generateOnce(context, chat, generationInput);
  const budget = chat.getContextStatus(result.conversationId, options.contextBudgetPolicy);
  if (budget.softLimitReached) {
    context.output.write("正在进行上下文压缩……\n");
    await chat.compactConversation({
      conversationId: result.conversationId,
      provider: options.provider,
      model: options.model,
      contextBudgetPolicy: options.contextBudgetPolicy,
      trigger: "automatic",
      signal: new AbortController().signal,
      ...(options.onDebugEvent === undefined ? {} : { onDebugEvent: options.onDebugEvent }),
    });
    context.output.write("上下文压缩完成。\n");
  }
  const savePath = optionString(parsed, "save");
  if (savePath !== undefined) {
    printSaved(
      context,
      await chat.saveGeneration(savePath, {
        generationId: result.generationId,
        overwrite: optionBoolean(parsed, "overwrite"),
      }),
    );
  }
}
