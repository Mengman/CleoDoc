#!/usr/bin/env node

import { createInterface, type Interface } from "node:readline/promises";
import { emitKeypressEvents, type Key } from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import { TextDecoder } from "node:util";
import { z } from "zod";

import {
  ChatInputController,
  ChatService,
  type LlmDebugHandler,
  type ToolApprovalHandler,
  type ToolApprovalRequest,
} from "../../../packages/agent/src/index.js";
import {
  AppError,
  asAppError,
  getExitCode,
  type ChatGenerationResult,
  type ConversationSummary,
  type ModelProvider,
  type SavedDocument,
} from "../../../packages/contracts/src/index.js";
import { MaterialService } from "../../../packages/knowledge/src/index.js";
import { createProvider, providerCatalog } from "../../../packages/model-providers/src/index.js";
import {
  ConfigService,
  DocumentService,
  ProjectService,
} from "../../../packages/project/src/index.js";
import {
  assertOnlyOptions,
  optionBoolean,
  optionString,
  parseArguments,
  type ParsedArguments,
  validateInput,
} from "./arguments.js";
import { helpText } from "./help.js";
import { LlmDebugFileLogger } from "./debug-log.js";

const projectService = new ProjectService();
const configService = new ConfigService();

async function main(argumentsList: readonly string[]): Promise<void> {
  const parsed = parseArguments(argumentsList);
  switch (parsed.command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      output.write(helpText);
      return;
    case "--version":
    case "version":
      output.write("0.1.0\n");
      return;
    case "init":
      await initCommand(parsed);
      return;
    case "open":
      await openCommand(parsed);
      return;
    case "status":
      await statusCommand(parsed);
      return;
    case "config":
      await configCommand(parsed);
      return;
    case "provider":
      await providerCommand(parsed);
      return;
    case "document":
      await documentCommand(parsed);
      return;
    case "material":
      await materialCommand(parsed);
      return;
    case "conversation":
      await conversationCommand(parsed);
      return;
    case "chat":
      await chatCommand(parsed);
      return;
    default:
      throw new AppError("VALIDATION_ERROR", `未知命令：${parsed.command}`);
  }
}

async function initCommand(parsed: ParsedArguments): Promise<void> {
  assertOnlyOptions(parsed, ["name"]);
  const inputValue = validateInput(
    z.object({ directory: z.string().min(1), name: z.string().min(1).optional() }),
    { directory: parsed.positionals[0], name: optionString(parsed, "name") },
  );
  if (parsed.positionals.length !== 1) {
    throw new AppError("VALIDATION_ERROR", "用法：cleo init <directory> [--name <作品名>]");
  }
  const project = await projectService.create(inputValue.directory, inputValue.name);
  await configService.setCurrentProject(project.root);
  output.write(`已创建项目：${project.manifest.name}\n`);
  output.write(`项目目录：${project.root}\n`);
  output.write(`项目 ID：${project.manifest.id}\n`);
}

async function openCommand(parsed: ParsedArguments): Promise<void> {
  assertOnlyOptions(parsed, []);
  if (parsed.positionals.length !== 1 || parsed.positionals[0] === undefined) {
    throw new AppError("VALIDATION_ERROR", "用法：cleo open <directory>");
  }
  const project = await projectService.open(parsed.positionals[0]);
  await configService.setCurrentProject(project.root);
  output.write(`当前项目：${project.manifest.name}\n${project.root}\n`);
}

async function statusCommand(parsed: ParsedArguments): Promise<void> {
  assertOnlyOptions(parsed, ["project"]);
  if (parsed.positionals.length !== 0) {
    throw new AppError("VALIDATION_ERROR", "用法：cleo status [--project <directory>]");
  }
  const root = await resolveProjectRoot(optionString(parsed, "project"));
  const status = await projectService.status(root);
  output.write(`项目：${status.manifest.name}\n`);
  output.write(`目录：${status.root}\n`);
  output.write(`数据库：${status.database}\n`);
  output.write(`正文文档：${status.documentCount}\n`);
}

async function configCommand(parsed: ParsedArguments): Promise<void> {
  assertOnlyOptions(parsed, []);
  if (parsed.positionals.length !== 0) {
    throw new AppError("VALIDATION_ERROR", "用法：cleo config");
  }
  const config = await configService.read();
  output.write(`配置目录：${configService.homeDirectory}\n`);
  output.write(`当前项目：${config.currentProject ?? "未设置"}\n`);
  output.write(`OPENAI_API_KEY：${process.env.OPENAI_API_KEY ? "已设置" : "未设置"}\n`);
  output.write(`OPENAI_BASE_URL：${process.env.OPENAI_BASE_URL ? "已设置" : "使用默认值"}\n`);
  output.write(`OLLAMA_BASE_URL：${process.env.OLLAMA_BASE_URL ? "已设置" : "使用默认值"}\n`);
}

async function providerCommand(parsed: ParsedArguments): Promise<void> {
  const [subcommand, providerId] = parsed.positionals;
  if (subcommand === "list") {
    assertOnlyOptions(parsed, []);
    for (const provider of providerCatalog) {
      output.write(
        `${provider.id}\t${provider.displayName}\t${provider.apiKeyEnv ?? "无需 API Key"}\n`,
      );
    }
    return;
  }
  if (subcommand !== "test" || providerId === undefined || parsed.positionals.length !== 2) {
    throw new AppError("VALIDATION_ERROR", "用法：cleo provider <list|test <provider>>");
  }
  assertOnlyOptions(parsed, [
    "base-url",
    "api-key-env",
    "connect-timeout-ms",
    "stream-idle-timeout-ms",
    "generation-timeout-ms",
  ]);
  const provider = providerFromArguments(providerId, parsed);
  const controller = new AbortController();
  const removeHandler = installInterruptHandler(controller);
  try {
    const health = await provider.validateConfiguration(controller.signal);
    output.write(`${provider.displayName}：${health.message}\n`);
    for (const model of health.models ?? []) {
      output.write(`  ${model}\n`);
    }
  } finally {
    removeHandler();
  }
}

async function documentCommand(parsed: ParsedArguments): Promise<void> {
  const [subcommand, reference] = parsed.positionals;
  assertOnlyOptions(parsed, ["project", "content", "overwrite"]);
  const root = await resolveProjectRoot(optionString(parsed, "project"));
  const project = await projectService.open(root);
  const documents = new DocumentService(project.root);

  switch (subcommand) {
    case "list": {
      if (parsed.positionals.length !== 1) {
        throw new AppError("VALIDATION_ERROR", "用法：cleo document list");
      }
      const list = await documents.list();
      if (list.length === 0) {
        output.write("尚无正文文档。\n");
      }
      for (const document of list) {
        output.write(`${document.id}\t${document.relativePath}\t${document.size} bytes\n`);
      }
      return;
    }
    case "show": {
      if (reference === undefined || parsed.positionals.length !== 2) {
        throw new AppError("VALIDATION_ERROR", "用法：cleo document show <document-id|path>");
      }
      const document = await documents.read(reference);
      output.write(`--- ${document.summary.relativePath} (${document.summary.id}) ---\n`);
      output.write(document.content);
      if (!document.content.endsWith("\n")) {
        output.write("\n");
      }
      return;
    }
    case "create": {
      if (reference === undefined || parsed.positionals.length !== 2) {
        throw new AppError(
          "VALIDATION_ERROR",
          "用法：cleo document create <path> [--content <text>]",
        );
      }
      const saved = await documents.save(reference, optionString(parsed, "content") ?? "");
      printSaved(saved);
      return;
    }
    case "save-last": {
      if (reference === undefined || parsed.positionals.length !== 2) {
        throw new AppError("VALIDATION_ERROR", "用法：cleo document save-last <path>");
      }
      const chat = await ChatService.open(project.root);
      try {
        const saved = await chat.saveGeneration(reference, {
          overwrite: optionBoolean(parsed, "overwrite"),
        });
        printSaved(saved);
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
      output.write(`已删除：${deleted.relativePath}\n`);
      return;
    }
    default:
      throw new AppError("VALIDATION_ERROR", "未知 document 子命令。");
  }
}

async function materialCommand(parsed: ParsedArguments): Promise<void> {
  const [subcommand, reference, value] = parsed.positionals;
  assertOnlyOptions(parsed, ["project", "stdin", "title", "source", "tags", "format"]);
  const root = await resolveProjectRoot(optionString(parsed, "project"));
  const materials = await MaterialService.open(root);
  try {
    switch (subcommand) {
      case "add": {
        const fromStdin = optionBoolean(parsed, "stdin");
        const title = optionString(parsed, "title");
        const sourceLabel = optionString(parsed, "source");
        const tags = parseTags(optionString(parsed, "tags"));
        const requestedFormat = optionString(parsed, "format");
        if (fromStdin) {
          if (reference !== undefined || parsed.positionals.length !== 1) {
            throw new AppError("VALIDATION_ERROR", "用法：cleo material add --stdin [选项]");
          }
          if (requestedFormat !== undefined && !["text", "markdown"].includes(requestedFormat)) {
            throw new AppError("VALIDATION_ERROR", "--format 只能是 text 或 markdown。");
          }
          const result = await materials.addText(await readStandardInput(), {
            ...(title === undefined ? {} : { title }),
            ...(sourceLabel === undefined ? {} : { sourceLabel }),
            ...(tags.length === 0 ? {} : { tags }),
            ...(requestedFormat === undefined
              ? {}
              : { format: requestedFormat as "text" | "markdown" }),
          });
          printMaterialImported(result);
          return;
        }
        if (reference === undefined || parsed.positionals.length !== 2) {
          throw new AppError("VALIDATION_ERROR", "用法：cleo material add <file> [选项]");
        }
        if (requestedFormat !== undefined) {
          throw new AppError("VALIDATION_ERROR", "导入文件时由扩展名决定格式，不能使用 --format。");
        }
        const result = await materials.addFile(reference, {
          ...(title === undefined ? {} : { title }),
          ...(sourceLabel === undefined ? {} : { sourceLabel }),
          ...(tags.length === 0 ? {} : { tags }),
        });
        printMaterialImported(result);
        return;
      }
      case "list": {
        assertMaterialPositionals(parsed, 1, "cleo material list");
        assertMaterialOptionsUnused(parsed, ["project"]);
        const list = await materials.list();
        if (list.length === 0) {
          output.write("尚无资料。\n");
        }
        for (const source of list) {
          output.write(
            `${source.id}\t${source.title}\t${source.format}\t${source.size} bytes\t${source.tags.join(",")}\n`,
          );
        }
        return;
      }
      case "show": {
        assertMaterialPositionals(parsed, 2, "cleo material show <material-id>");
        assertMaterialOptionsUnused(parsed, ["project"]);
        const material = await materials.get(reference!);
        printMaterialMetadata(material.source);
        output.write("--- 内容 ---\n");
        output.write(material.content);
        if (!material.content.endsWith("\n")) {
          output.write("\n");
        }
        return;
      }
      case "rename": {
        assertMaterialPositionals(parsed, 3, "cleo material rename <material-id> <title>");
        assertMaterialOptionsUnused(parsed, ["project"]);
        const renamed = await materials.rename(reference!, value!);
        output.write(`已重命名资料：${renamed.title}（${renamed.id}）\n`);
        return;
      }
      case "remove": {
        assertMaterialPositionals(parsed, 2, "cleo material remove <material-id>");
        assertMaterialOptionsUnused(parsed, ["project"]);
        const removed = await materials.remove(reference!);
        output.write(`已删除资料：${removed.title}（${removed.id}）\n`);
        return;
      }
      default:
        throw new AppError("VALIDATION_ERROR", "用法：cleo material <add|list|show|rename|remove>");
    }
  } finally {
    await materials.close();
  }
}

function assertMaterialPositionals(parsed: ParsedArguments, expected: number, usage: string): void {
  if (parsed.positionals.length !== expected) {
    throw new AppError("VALIDATION_ERROR", `用法：${usage}`);
  }
}

function assertMaterialOptionsUnused(parsed: ParsedArguments, allowed: readonly string[]): void {
  assertOnlyOptions(parsed, allowed);
}

function parseTags(value: string | undefined): string[] {
  return value === undefined ? [] : value.split(",").map((tag) => tag.trim());
}

async function readStandardInput(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of input) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.byteLength;
    if (size > 10 * 1024 * 1024) {
      throw new AppError("VALIDATION_ERROR", "标准输入资料不能超过 10 MiB。");
    }
    chunks.push(buffer);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch (error) {
    throw new AppError("VALIDATION_ERROR", "标准输入资料必须是有效的 UTF-8 文本。", {
      cause: error,
    });
  }
}

function printMaterialImported(result: Awaited<ReturnType<MaterialService["addText"]>>): void {
  output.write(
    `${result.created ? "已添加资料" : "资料已存在，未重复导入"}：${result.source.title}\n`,
  );
  output.write(`资料 ID：${result.source.id}\n路径：${result.source.relativePath}\n`);
  output.write(`内容哈希：${result.source.contentHash}\n`);
}

function printMaterialMetadata(source: Awaited<ReturnType<MaterialService["list"]>>[number]): void {
  output.write(`资料：${source.title}\n`);
  output.write(`资料 ID：${source.id}\n`);
  output.write(`格式：${source.format}\n来源：${source.sourceLabel ?? "未指定"}\n`);
  output.write(`标签：${source.tags.length === 0 ? "无" : source.tags.join(", ")}\n`);
  output.write(`路径：${source.relativePath}\n内容哈希：${source.contentHash}\n`);
  output.write(`创建时间：${source.createdAt}\n更新时间：${source.updatedAt}\n`);
}

async function chatCommand(parsed: ParsedArguments): Promise<void> {
  assertOnlyOptions(parsed, [
    "project",
    "provider",
    "model",
    "base-url",
    "api-key-env",
    "connect-timeout-ms",
    "stream-idle-timeout-ms",
    "generation-timeout-ms",
    "context-window-tokens",
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
  const root = await resolveProjectRoot(optionString(parsed, "project"));
  const project = await projectService.open(root);
  const providerId = optionString(parsed, "provider") ?? "openai-compatible";
  const provider = providerFromArguments(providerId, parsed);
  const model = optionString(parsed, "model") ?? process.env.CLEODOC_MODEL;
  if (!model) {
    throw new AppError("VALIDATION_ERROR", "请使用 --model 或 CLEODOC_MODEL 指定模型。");
  }
  const debug = optionBoolean(parsed, "debug");
  const contextWindowTokens =
    optionPositiveInteger(parsed, "context-window-tokens") ??
    parsePositiveEnvironmentInteger("CLEODOC_MODEL_CONTEXT_TOKENS");
  if (contextWindowTokens !== undefined && contextWindowTokens < 2_048) {
    throw new AppError("VALIDATION_ERROR", "模型上下文窗口不能小于 2048 Token。");
  }
  const chat = await ChatService.open(project.root);
  const debugLogger = debug ? await LlmDebugFileLogger.create(project.root) : undefined;
  const onDebugEvent = debugLogger?.onEvent;
  if (debugLogger !== undefined) {
    output.write(`Debug 日志：${debugLogger.filePath}\n`);
    output.write("日志可能包含作品或资料；鉴权 Header 已脱敏。\n");
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
      const result = await generateOnce(chat, {
        projectId: project.manifest.id,
        provider,
        model,
        prompt,
        conversationId: initialConversationId,
        contextWindowTokens,
        ...(onDebugEvent === undefined ? {} : { onDebugEvent }),
      });
      const budget = chat.getContextStatus(result.conversationId, contextWindowTokens);
      if (budget.softLimitReached) {
        output.write("正在进行上下文压缩……\n");
        await chat.compactConversation({
          conversationId: result.conversationId,
          provider,
          model,
          contextWindowTokens,
          trigger: "automatic",
          signal: new AbortController().signal,
          ...(onDebugEvent === undefined ? {} : { onDebugEvent }),
        });
        output.write("上下文压缩完成。\n");
      }
      const savePath = optionString(parsed, "save");
      if (savePath !== undefined) {
        const saved = await chat.saveGeneration(savePath, {
          generationId: result.generationId,
          overwrite: optionBoolean(parsed, "overwrite"),
        });
        printSaved(saved);
      }
      return;
    }
    if (parsed.options.has("save") || parsed.options.has("overwrite")) {
      throw new AppError("VALIDATION_ERROR", "--save 和 --overwrite 仅用于 --prompt 单轮模式。");
    }
    await interactiveChat(chat, {
      projectId: project.manifest.id,
      provider,
      model,
      initialConversationId,
      createProvider: (selectedProviderId) => providerFromArguments(selectedProviderId, parsed),
      documents: new DocumentService(project.root),
      contextWindowTokens,
      ...(onDebugEvent === undefined ? {} : { onDebugEvent }),
    });
  } finally {
    try {
      await chat.close();
    } finally {
      await debugLogger?.close();
    }
  }
}

async function conversationCommand(parsed: ParsedArguments): Promise<void> {
  const [subcommand, conversationId] = parsed.positionals;
  assertOnlyOptions(parsed, ["project"]);
  const root = await resolveProjectRoot(optionString(parsed, "project"));
  const project = await projectService.open(root);
  const chat = await ChatService.open(project.root);
  try {
    if (subcommand === "list" && parsed.positionals.length === 1) {
      const conversations = chat.listConversations(project.manifest.id);
      if (conversations.length === 0) {
        output.write("尚无聊天记录。\n");
      }
      for (const conversation of conversations) {
        output.write(
          `${conversation.id}\t${conversation.updatedAt}\t${conversation.providerId}/${conversation.model}\t${conversation.messageCount} 条消息\t${conversation.title ?? "未命名"}\n`,
        );
      }
      return;
    }
    if (subcommand === "show" && conversationId !== undefined && parsed.positionals.length === 2) {
      printConversationHistory(chat.getConversationHistory(conversationId));
      return;
    }
    throw new AppError("VALIDATION_ERROR", "用法：cleo conversation <list|show <conversation-id>>");
  } finally {
    await chat.close();
  }
}

async function generateOnce(
  chat: ChatService,
  inputValue: {
    projectId: string;
    provider: ModelProvider;
    model: string;
    prompt: string;
    conversationId?: string;
    approveToolCall?: ToolApprovalHandler;
    contextWindowTokens?: number;
    onDebugEvent?: LlmDebugHandler;
  },
): Promise<ChatGenerationResult> {
  const controller = new AbortController();
  const removeHandler = installInterruptHandler(controller);
  let displayPhase: "idle" | "reasoning" | "answer" | "tool" = "idle";
  try {
    const result = await chat.send({
      ...inputValue,
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === "reasoning-delta") {
          if (displayPhase !== "reasoning") {
            output.write(`${displayPhase === "idle" ? "\n" : "\n\n"}思考中：\n`);
            displayPhase = "reasoning";
          }
          output.write(event.text);
        } else if (event.type === "text-delta") {
          if (displayPhase === "reasoning" || displayPhase === "tool") {
            output.write("\n\n回答：\n");
          }
          displayPhase = "answer";
          output.write(event.text);
        } else if (event.type === "tool-call") {
          output.write(`\n[工具请求] ${event.call.name}\n`);
          displayPhase = "tool";
        }
      },
    });
    output.write("\n");
    output.write(`对话 ID：${result.conversationId}\n生成 ID：${result.generationId}\n`);
    return result;
  } finally {
    removeHandler();
  }
}

async function interactiveChat(
  chat: ChatService,
  context: {
    projectId: string;
    provider: ModelProvider;
    model: string;
    initialConversationId?: string;
    createProvider: (providerId: string) => ModelProvider;
    documents: DocumentService;
    contextWindowTokens?: number;
    onDebugEvent?: LlmDebugHandler;
  },
): Promise<void> {
  let readline = createInterface({ input, output });
  let conversationId = context.initialConversationId;
  let provider = context.provider;
  let model = context.model;
  const inputController = new ChatInputController();
  let compaction: { promise: Promise<void>; controller: AbortController; hard: boolean } | null =
    null;
  let hardBlocked = false;
  const recentConversations = chat.listConversations(context.projectId).slice(0, 5);

  output.write(`已连接 ${provider.displayName} / ${model}。输入 /help 查看命令。\n`);
  printRecentConversations(recentConversations);
  if (conversationId !== undefined) {
    output.write(`已恢复命令行指定的对话 ${conversationId}。\n`);
  } else if (recentConversations.length > 0) {
    output.write("输入 /resume <序号> 快速恢复，或直接输入内容开始新对话。\n");
  }

  const resumeConversation = (conversation: ConversationSummary): void => {
    provider = context.createProvider(conversation.providerId);
    model = conversation.model;
    conversationId = conversation.id;
    output.write(
      `已恢复对话 [${conversation.id}]，使用 ${provider.displayName} / ${model}，共 ${conversation.messageCount} 条消息。\n`,
    );
  };

  const startCompaction = (trigger: "automatic" | "manual", hard: boolean): void => {
    if (conversationId === undefined || compaction !== null) return;
    inputController.setSubmissionBlocked("正在进行上下文压缩");
    const targetConversationId = conversationId;
    const controller = new AbortController();
    const cancelCompaction = (): void => {
      output.write("\n正在取消上下文压缩……\n");
      controller.abort();
    };
    readline.once("SIGINT", cancelCompaction);
    output.write("正在进行上下文压缩，你可以继续输入；压缩完成后再按 Enter 提交。\n");
    const promise = chat
      .compactConversation({
        conversationId: targetConversationId,
        provider,
        model,
        contextWindowTokens: context.contextWindowTokens,
        trigger,
        signal: controller.signal,
        ...(context.onDebugEvent === undefined ? {} : { onDebugEvent: context.onDebugEvent }),
      })
      .then(() => {
        hardBlocked = false;
        inputController.allowSubmission();
        output.write("\n上下文压缩完成，可以提交。\n");
      })
      .catch((error: unknown) => {
        const appError = asAppError(error);
        hardBlocked = hard;
        if (!hard) inputController.allowSubmission();
        if (hard) {
          output.write(
            "\n上下文已接近模型限制，压缩未能完成。当前输入已保留，请重试压缩或检查模型连接。\n",
          );
        } else {
          output.write("\n上下文压缩失败，原会话仍然有效。当前输入已保留，系统稍后会重试压缩。\n");
        }
        output.write(`压缩错误 [${appError.code}]：${appError.message}\n`);
      })
      .finally(() => {
        readline.off("SIGINT", cancelCompaction);
        if (compaction?.promise === promise) compaction = null;
      });
    compaction = { promise, controller, hard };
  };

  try {
    while (true) {
      const question = readline.question("你：");
      if (inputController.draft !== "" && input.isTTY) readline.write(inputController.draft);
      const rawLine = await question;
      inputController.captureDraft(rawLine);
      const rawCommand = rawLine.trim();
      const bypassBlock =
        compaction === null &&
        (rawCommand === "/retry-compact" ||
          rawCommand === "/context" ||
          rawCommand === "/sessions" ||
          rawCommand.startsWith("/session "));
      const submitted = inputController.submit({ bypassBlock });
      if (submitted === null) {
        inputController.preserveDraft();
        output.write(
          compaction === null
            ? "上下文接近模型限制，当前输入已保留；请先使用 /retry-compact。\n"
            : "上下文仍在压缩，当前输入已保留；完成后请再次按 Enter 提交。\n",
        );
        continue;
      }
      const line = submitted.trim();
      if (line === "") {
        continue;
      }
      if (line === "/exit") {
        return;
      }
      if (line === "/help") {
        output.write(
          "/resume <序号>  /history  /new  /compact  /retry-compact  /sessions  /session <序号>  /context  /save <path>  /read <path>  /documents  /exit\n",
        );
        continue;
      }
      if (line === "/resume" || line.startsWith("/resume ")) {
        const match = /^\/resume\s+(\d+)$/.exec(line);
        const selectedIndex = match?.[1] === undefined ? Number.NaN : Number(match[1]) - 1;
        const selected = recentConversations[selectedIndex];
        if (selected === undefined) {
          output.write(
            `请输入有效序号，例如 /resume 1；当前可选范围为 1–${recentConversations.length}。\n`,
          );
        } else {
          resumeConversation(selected);
        }
        continue;
      }
      if (line === "/new") {
        conversationId = undefined;
        output.write("下一条消息将开始新对话。已有聊天记录不会被删除。\n");
        continue;
      }
      if (line === "/compact" || line === "/retry-compact") {
        if (conversationId === undefined) {
          output.write("请先发送一条消息创建对话。\n");
        } else {
          startCompaction("manual", hardBlocked);
        }
        continue;
      }
      if (line === "/context") {
        if (conversationId === undefined) {
          output.write("请先发送一条消息创建对话。\n");
        } else {
          printContextStatus(chat.getContextStatus(conversationId, context.contextWindowTokens));
        }
        continue;
      }
      if (line === "/sessions") {
        if (conversationId === undefined) output.write("请先发送一条消息创建对话。\n");
        else printSessions(chat.getSessions(conversationId));
        continue;
      }
      if (line.startsWith("/session ")) {
        if (conversationId === undefined) {
          output.write("请先发送一条消息创建对话。\n");
          continue;
        }
        const ordinal = Number(line.slice(9).trim());
        if (!Number.isInteger(ordinal) || ordinal <= 0) {
          output.write("Session 序号必须是正整数。\n");
          continue;
        }
        printSession(chat.getSessionDetails(conversationId, ordinal));
        continue;
      }
      if (line === "/history") {
        const conversations = chat.listConversations(context.projectId);
        readline.close();
        const selected = await selectConversationFromHistory(conversations);
        readline = createInterface({ input, output });
        if (selected !== null) {
          resumeConversation(selected);
        }
        continue;
      }
      if (line === "/documents") {
        await printDocuments(context.documents);
        continue;
      }
      if (line.startsWith("/save ")) {
        await saveInteractively(chat, readline, line.slice(6).trim());
        continue;
      }
      if (line.startsWith("/read ")) {
        if (conversationId === undefined) {
          output.write("请先发送一条消息创建对话，再读取文档。\n");
          continue;
        }
        const documentPath = line.slice(6).trim();
        await chat.readDocumentIntoConversation(conversationId, documentPath);
        output.write(`已将 ${documentPath} 加入后续对话上下文。\n`);
        continue;
      }
      if (conversationId !== undefined) {
        const preflight = chat.getContextStatus(
          conversationId,
          context.contextWindowTokens,
          undefined,
          line,
        );
        if (preflight.hardLimitReached || hardBlocked) {
          inputController.captureDraft(rawLine);
          startCompaction("automatic", true);
          continue;
        }
      }
      output.write("主笔：");
      try {
        const result = await generateOnce(chat, {
          projectId: context.projectId,
          provider,
          model,
          prompt: line,
          ...(conversationId === undefined ? {} : { conversationId }),
          approveToolCall: (request) => approveProjectWrite(readline, request),
          contextWindowTokens: context.contextWindowTokens,
          ...(context.onDebugEvent === undefined ? {} : { onDebugEvent: context.onDebugEvent }),
        });
        conversationId = result.conversationId;
        const budget = chat.getContextStatus(conversationId, context.contextWindowTokens);
        if (budget.softLimitReached) startCompaction("automatic", budget.hardLimitReached);
      } catch (error) {
        const appError = asAppError(error);
        const failedConversationId = appError.details?.conversationId;
        if (typeof failedConversationId === "string") {
          conversationId = failedConversationId;
        }
        if (!isRecoverableChatError(appError)) {
          throw appError;
        }
        output.write("\n");
        printRecoverableChatError(appError);
      }
    }
  } finally {
    const pendingCompaction = compaction as {
      promise: Promise<void>;
      controller: AbortController;
      hard: boolean;
    } | null;
    if (pendingCompaction !== null) {
      pendingCompaction.controller.abort();
      await pendingCompaction.promise;
    }
    readline.close();
    output.write("聊天记录已保存在当前项目中。\n");
  }
}

function printContextStatus(status: ReturnType<ChatService["getContextStatus"]>): void {
  output.write(`预计输入：${status.estimatedInputTokens} tokens\n`);
  output.write(`可用预算：${status.effectiveLimitTokens} tokens\n`);
  output.write(`占用比例：${(status.ratio * 100).toFixed(1)}%\n`);
  output.write(
    `状态：${status.hardLimitReached ? "硬限制" : status.softLimitReached ? "需要压缩" : "正常"}\n`,
  );
}

function printSessions(sessions: ReturnType<ChatService["getSessions"]>): void {
  for (const session of sessions) {
    output.write(
      `[${session.ordinal}] ${session.status} | ${session.trigger} | ${session.startedAt}${session.closedAt === null ? "" : ` → ${session.closedAt}`}\n`,
    );
  }
}

function printSession(details: ReturnType<ChatService["getSessionDetails"]>): void {
  const { session } = details;
  output.write(`Session ${session.ordinal} (${session.status})\n`);
  output.write(`ID：${session.id}\n触发：${session.trigger}\n开始：${session.startedAt}\n`);
  output.write(`结束：${session.closedAt ?? "未结束"}\n`);
  output.write(`AGENTS：${session.projectInstructionsPath ?? "未加载"}\n`);
  output.write(`AGENTS SHA-256：${session.projectInstructionsHash ?? "无"}\n`);
  output.write(`继承摘要：${session.inheritedSummaryId ?? "无"}\n`);
  output.write(
    `消息范围：${details.firstMessageId ?? "无"} → ${details.lastMessageId ?? "无"}（${details.messageCount} 条）\n`,
  );
  if (details.summary !== null) {
    output.write(`累计摘要：${details.summary.summary}\n`);
  }
}

async function approveProjectWrite(
  readline: Interface,
  request: ToolApprovalRequest,
): Promise<boolean> {
  output.write(`\nLLM 请求${request.overwrite ? "覆盖" : "创建"}项目文档：${request.path}\n`);
  output.write(`内容长度：${request.contentLength} 字符\n`);
  const preview = sanitizeTerminalText(request.contentPreview);
  if (preview !== "") {
    output.write(`内容预览：${truncateText(preview, 240)}\n`);
  }
  const answer = (await readline.question("允许本次写入？[y/N] ")).trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

function printRecentConversations(conversations: readonly ConversationSummary[]): void {
  if (conversations.length === 0) {
    output.write("最近聊天：暂无记录。\n");
    return;
  }
  output.write("最近 5 条聊天记录：\n");
  printConversationChoices(conversations);
}

function printConversationChoices(conversations: readonly ConversationSummary[]): void {
  conversations.forEach((conversation, index) => {
    output.write(`${formatConversationChoice(conversation, index)}\n`);
  });
}

function formatConversationChoice(conversation: ConversationSummary, index: number): string {
  const title = sanitizeTerminalText(conversation.title ?? "未命名对话");
  const date = new Date(conversation.updatedAt).toLocaleString("zh-CN");
  return `[${index + 1}] ${truncateText(title, 42)} | ${conversation.providerId}/${conversation.model} | ${conversation.messageCount} 条 | ${date}`;
}

async function selectConversationFromHistory(
  conversations: readonly ConversationSummary[],
): Promise<ConversationSummary | null> {
  if (conversations.length === 0) {
    output.write("尚无聊天记录。\n");
    return null;
  }
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    output.write("聊天历史：\n");
    printConversationChoices(conversations);
    output.write("当前终端不支持方向键选择，请使用 /resume <序号> 恢复最近记录。\n");
    return null;
  }

  emitKeypressEvents(input);
  const previousRawMode = input.isRaw;
  let selectedIndex = 0;
  output.write("\u001b[?1049h\u001b[?25l");
  input.setRawMode(true);
  input.resume();

  return new Promise((resolve) => {
    const finish = (selection: ConversationSummary | null): void => {
      input.off("keypress", onKeypress);
      input.setRawMode(previousRawMode === true);
      input.pause();
      output.write("\u001b[?25h\u001b[?1049l");
      resolve(selection);
    };
    const render = (): void => {
      const viewportSize = 12;
      const start = Math.max(
        0,
        Math.min(selectedIndex - Math.floor(viewportSize / 2), conversations.length - viewportSize),
      );
      const end = Math.min(conversations.length, start + viewportSize);
      output.write("\u001b[2J\u001b[H");
      output.write("聊天历史 — ↑/↓ 选择，Enter 恢复，q 退出\n\n");
      for (let index = start; index < end; index += 1) {
        const line = formatConversationChoice(conversations[index]!, index);
        output.write(index === selectedIndex ? `\u001b[7m${line}\u001b[0m\n` : `${line}\n`);
      }
      output.write(`\n${selectedIndex + 1}/${conversations.length}\n`);
    };
    const onKeypress = (_character: string, key: Key): void => {
      if (key.name === "up") {
        selectedIndex = (selectedIndex - 1 + conversations.length) % conversations.length;
        render();
      } else if (key.name === "down") {
        selectedIndex = (selectedIndex + 1) % conversations.length;
        render();
      } else if (key.name === "return" || key.name === "enter") {
        finish(conversations[selectedIndex] ?? null);
      } else if (key.name === "q" || key.name === "escape" || (key.ctrl && key.name === "c")) {
        finish(null);
      }
    };
    input.on("keypress", onKeypress);
    render();
  });
}

function sanitizeTerminalText(value: string): string {
  return [...value]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159) ? " " : character;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateText(value: string, maximumLength: number): string {
  return value.length <= maximumLength ? value : `${value.slice(0, maximumLength - 1)}…`;
}

function printConversationHistory(
  messages: ReturnType<ChatService["getConversationHistory"]>,
): void {
  if (messages.length === 0) {
    output.write("该对话没有消息。\n");
    return;
  }
  for (const message of messages) {
    const role =
      message.role === "user"
        ? "用户"
        : message.role === "assistant"
          ? "主笔"
          : message.role === "system"
            ? "系统"
            : "工具";
    output.write(`[${message.createdAt}] ${role}：\n`);
    if (message.toolCalls !== undefined) {
      output.write(`[调用工具] ${message.toolCalls.map((call) => call.name).join(", ")}\n`);
    }
    if (message.reasoningContent !== undefined) {
      output.write(`思考中：\n${message.reasoningContent}\n`);
      if (message.content !== "") output.write("回答：\n");
    }
    if (message.role === "tool") {
      output.write(`[${message.name ?? "未知工具"}] ${message.content}\n\n`);
    } else {
      output.write(`${message.content}\n\n`);
    }
  }
}

function isRecoverableChatError(error: AppError): boolean {
  return [
    "PROVIDER_AUTH_ERROR",
    "PROVIDER_RATE_LIMITED",
    "PROVIDER_CONTEXT_LIMIT",
    "PROVIDER_TIMEOUT",
    "PROVIDER_UNAVAILABLE",
    "GENERATION_CANCELLED",
  ].includes(error.code);
}

function printRecoverableChatError(error: AppError): void {
  if (error.code === "PROVIDER_TIMEOUT") {
    const timeoutKind = error.details?.timeoutKind;
    const message =
      timeoutKind === "connection"
        ? "连接模型服务或等待首个响应超时"
        : timeoutKind === "stream_idle"
          ? "模型响应流长时间没有返回新数据"
          : timeoutKind === "overall"
            ? "本轮模型生成超过总时间限制"
            : timeoutKind === "upstream"
              ? "上游模型服务返回超时"
              : "模型服务请求超时";
    output.write(`${message}，本轮消息已经保存。聊天仍然保持，可以稍后再次尝试。\n`);
    return;
  }
  if (error.code === "GENERATION_CANCELLED") {
    output.write("本轮生成已取消，之前的聊天记录已经保存，可以继续聊天。\n");
    return;
  }
  output.write(`模型调用失败 [${error.code}]：${error.message}\n`);
  output.write("聊天仍然保持，之前的记录已经保存，可以修正配置后再次尝试。\n");
}

async function saveInteractively(
  chat: ChatService,
  readline: Interface,
  path: string,
): Promise<void> {
  try {
    printSaved(await chat.saveGeneration(path));
  } catch (error) {
    const appError = asAppError(error);
    if (appError.code !== "DOCUMENT_ALREADY_EXISTS") {
      throw appError;
    }
    const answer = (await readline.question("文档已存在，确认覆盖？[y/N] ")).trim().toLowerCase();
    if (answer === "y" || answer === "yes") {
      printSaved(await chat.saveGeneration(path, { overwrite: true }));
    } else {
      output.write("已取消保存。\n");
    }
  }
}

async function printDocuments(documents: DocumentService): Promise<void> {
  const list = await documents.list();
  if (list.length === 0) {
    output.write("尚无正文文档。\n");
  }
  for (const document of list) {
    output.write(`${document.id}\t${document.relativePath}\n`);
  }
}

function providerFromArguments(providerId: string, parsed: ParsedArguments): ModelProvider {
  return createProvider(providerId, {
    baseUrl: optionString(parsed, "base-url"),
    apiKeyEnvironmentVariable: optionString(parsed, "api-key-env"),
    connectionTimeoutMs: optionPositiveInteger(parsed, "connect-timeout-ms"),
    streamIdleTimeoutMs: optionPositiveInteger(parsed, "stream-idle-timeout-ms"),
    overallTimeoutMs: optionPositiveInteger(parsed, "generation-timeout-ms"),
  });
}

function optionPositiveInteger(parsed: ParsedArguments, name: string): number | undefined {
  const value = optionString(parsed, name);
  if (value === undefined) {
    return undefined;
  }
  const label = name.endsWith("-ms") ? "正整数毫秒数" : "正整数";
  if (!/^\d+$/.test(value)) {
    throw new AppError("VALIDATION_ERROR", `--${name} 必须是${label}。`);
  }
  const parsedValue = Number(value);
  if (!Number.isSafeInteger(parsedValue) || parsedValue <= 0) {
    throw new AppError("VALIDATION_ERROR", `--${name} 必须是${label}。`);
  }
  return parsedValue;
}

function parsePositiveEnvironmentInteger(name: string): number | undefined {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") return undefined;
  if (!/^\d+$/.test(value)) {
    throw new AppError("VALIDATION_ERROR", `${name} 必须是正整数。`);
  }
  const parsedValue = Number(value);
  if (!Number.isSafeInteger(parsedValue) || parsedValue <= 0) {
    throw new AppError("VALIDATION_ERROR", `${name} 必须是正整数。`);
  }
  return parsedValue;
}

async function resolveProjectRoot(explicitProject: string | undefined): Promise<string> {
  if (explicitProject !== undefined) {
    return (await projectService.open(explicitProject)).root;
  }
  const config = await configService.read();
  if (config.currentProject === null) {
    throw new AppError("PROJECT_NOT_FOUND", "尚未打开项目，请先运行 cleo open <directory>。");
  }
  return (await projectService.open(config.currentProject)).root;
}

function installInterruptHandler(controller: AbortController): () => void {
  const handler = (): void => {
    if (!controller.signal.aborted) {
      output.write("\n正在取消生成……\n");
      controller.abort();
    }
  };
  process.once("SIGINT", handler);
  return () => process.off("SIGINT", handler);
}

function printSaved(saved: SavedDocument): void {
  output.write(`${saved.created ? "已创建" : "已覆盖"}：${saved.relativePath}\n`);
  output.write(`文档 ID：${saved.id}\n内容哈希：${saved.contentHash}\n`);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  const appError = asAppError(error);
  process.stderr.write(`错误 [${appError.code}]：${appError.message}\n`);
  if (appError.details !== undefined) {
    process.stderr.write(`${JSON.stringify(appError.details, null, 2)}\n`);
  }
  process.exitCode = getExitCode(appError.code);
});
