import { createInterface, type Interface } from "node:readline/promises";

import {
  ChatInputController,
  type ChatService,
  createInstructionDiff,
  type ApprovalChoice,
  type LlmDebugHandler,
  type ToolApprovalRequest,
} from "../../../../packages/agent/src/index.js";
import {
  asAppError,
  type ContextBudgetPolicy,
  type ConversationSummary,
} from "../../../../packages/contracts/src/index.js";
import type { ProviderService } from "../../../../packages/model-providers/src/index.js";
import type { DocumentService } from "../../../../packages/project/src/index.js";
import type { CliCommandContext } from "./command-context.js";
import {
  isRecoverableChatError,
  printRecentConversations,
  printRecoverableChatError,
  sanitizeTerminalMultiline,
  sanitizeTerminalText,
  selectConversationFromHistory,
  truncateText,
} from "./conversation-ui.js";
import { printDocuments, saveInteractively } from "./document-output.js";
import { generateOnce } from "./send-chat-message.js";

export interface InteractiveChatOptions {
  readonly projectId: string;
  readonly provider: ProviderService;
  readonly model: string;
  readonly initialConversationId?: string;
  readonly createProviderService: (providerId: string, model: string) => ProviderService;
  readonly documents: DocumentService;
  readonly contextBudgetPolicy: ContextBudgetPolicy;
  readonly createContextBudgetPolicy: (providerId: string, model: string) => ContextBudgetPolicy;
  readonly onDebugEvent?: LlmDebugHandler;
}

export async function runInteractiveChat(
  context: CliCommandContext,
  chat: ChatService,
  options: InteractiveChatOptions,
): Promise<void> {
  let readline = createInterface({ input: context.input, output: context.output });
  let conversationId = options.initialConversationId;
  let provider = options.provider;
  let model = options.model;
  let contextBudgetPolicy = options.contextBudgetPolicy;
  const inputController = new ChatInputController();
  let compaction: { promise: Promise<void>; controller: AbortController; hard: boolean } | null =
    null;
  let hardBlocked = false;
  const recentConversations = chat.listConversations(options.projectId).slice(0, 5);

  context.output.write(`已连接 ${provider.displayName} / ${model}。输入 /help 查看命令。\n`);
  printRecentConversations(context, recentConversations);
  if (conversationId !== undefined) {
    context.output.write(`已恢复命令行指定的对话 ${conversationId}。\n`);
  } else if (recentConversations.length > 0) {
    context.output.write("输入 /resume <序号> 快速恢复，或直接输入内容开始新对话。\n");
  }

  const resumeConversation = (conversation: ConversationSummary): void => {
    provider = options.createProviderService(conversation.providerId, conversation.model);
    model = conversation.model;
    contextBudgetPolicy = options.createContextBudgetPolicy(conversation.providerId, model);
    conversationId = conversation.id;
    context.output.write(
      `已恢复对话 [${conversation.id}]，使用 ${provider.displayName} / ${model}，共 ${conversation.messageCount} 条消息。\n`,
    );
  };

  const startCompaction = (trigger: "automatic" | "manual", hard: boolean): void => {
    if (conversationId === undefined || compaction !== null) return;
    inputController.setSubmissionBlocked("正在进行上下文压缩");
    const targetConversationId = conversationId;
    const controller = new AbortController();
    const cancelCompaction = (): void => {
      context.output.write("\n正在取消上下文压缩……\n");
      controller.abort();
    };
    readline.once("SIGINT", cancelCompaction);
    context.output.write("正在进行上下文压缩，你可以继续输入；压缩完成后再按 Enter 提交。\n");
    const promise = chat
      .compactConversation({
        conversationId: targetConversationId,
        provider,
        model,
        contextBudgetPolicy,
        trigger,
        signal: controller.signal,
        ...(options.onDebugEvent === undefined ? {} : { onDebugEvent: options.onDebugEvent }),
      })
      .then(() => {
        hardBlocked = false;
        inputController.allowSubmission();
        context.output.write("\n上下文压缩完成，可以提交。\n");
      })
      .catch((error: unknown) => {
        const appError = asAppError(error);
        hardBlocked = hard;
        if (!hard) inputController.allowSubmission();
        context.output.write(
          hard
            ? "\n上下文已接近模型限制，压缩未能完成。当前输入已保留，请重试压缩或检查模型连接。\n"
            : "\n上下文压缩失败，原会话仍然有效。当前输入已保留，系统稍后会重试压缩。\n",
        );
        context.output.write(`压缩错误 [${appError.code}]：${appError.message}\n`);
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
      if (inputController.draft !== "" && context.input.isTTY) {
        readline.write(inputController.draft);
      }
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
        context.output.write(
          compaction === null
            ? "上下文接近模型限制，当前输入已保留；请先使用 /retry-compact。\n"
            : "上下文仍在压缩，当前输入已保留；完成后请再次按 Enter 提交。\n",
        );
        continue;
      }
      const line = submitted.trim();
      if (line === "") continue;
      if (line === "/exit") return;
      if (line === "/help") {
        context.output.write(
          "/resume <序号>  /history  /new  /compact  /retry-compact  /sessions  /session <序号>  /context  /instructions [history|restore <revision>]  /save <path>  /read <path>  /documents  /exit\n",
        );
        continue;
      }
      if (line === "/resume" || line.startsWith("/resume ")) {
        const match = /^\/resume\s+(\d+)$/.exec(line);
        const selectedIndex = match?.[1] === undefined ? Number.NaN : Number(match[1]) - 1;
        const selected = recentConversations[selectedIndex];
        if (selected === undefined) {
          context.output.write(
            `请输入有效序号，例如 /resume 1；当前可选范围为 1–${recentConversations.length}。\n`,
          );
        } else resumeConversation(selected);
        continue;
      }
      if (line === "/new") {
        conversationId = undefined;
        context.output.write("下一条消息将开始新对话。已有聊天记录不会被删除。\n");
        continue;
      }
      if (line === "/compact" || line === "/retry-compact") {
        if (conversationId === undefined) context.output.write("请先发送一条消息创建对话。\n");
        else startCompaction("manual", hardBlocked);
        continue;
      }
      if (line === "/context") {
        if (conversationId === undefined) context.output.write("请先发送一条消息创建对话。\n");
        else
          printContextStatus(context, chat.getContextStatus(conversationId, contextBudgetPolicy));
        continue;
      }
      if (line === "/sessions") {
        if (conversationId === undefined) context.output.write("请先发送一条消息创建对话。\n");
        else printSessions(context, chat.getSessions(conversationId));
        continue;
      }
      if (line.startsWith("/session ")) {
        if (conversationId === undefined) {
          context.output.write("请先发送一条消息创建对话。\n");
          continue;
        }
        const ordinal = Number(line.slice(9).trim());
        if (!Number.isInteger(ordinal) || ordinal <= 0) {
          context.output.write("Session 序号必须是正整数。\n");
          continue;
        }
        printSession(context, chat.getSessionDetails(conversationId, ordinal));
        continue;
      }
      if (line === "/history") {
        const conversations = chat.listConversations(options.projectId);
        readline.close();
        const selected = await selectConversationFromHistory(context, conversations);
        readline = createInterface({ input: context.input, output: context.output });
        if (selected !== null) resumeConversation(selected);
        continue;
      }
      if (line === "/documents") {
        await printDocuments(context, options.documents);
        continue;
      }
      if (line === "/instructions") {
        printProjectInstructions(context, chat.getProjectInstructions());
        continue;
      }
      if (line === "/instructions history") {
        printProjectInstructionHistory(context, chat.listProjectInstructionHistory());
        continue;
      }
      if (line.startsWith("/instructions restore ")) {
        await restoreProjectInstructions(context, chat, readline, line);
        continue;
      }
      if (line.startsWith("/save ")) {
        await saveInteractively(context, chat, readline, line.slice(6).trim());
        continue;
      }
      if (line.startsWith("/read ")) {
        if (conversationId === undefined) {
          context.output.write("请先发送一条消息创建对话，再读取文档。\n");
          continue;
        }
        const documentPath = line.slice(6).trim();
        await chat.readDocumentIntoConversation(conversationId, documentPath);
        context.output.write(`已将 ${documentPath} 加入后续对话上下文。\n`);
        continue;
      }
      if (conversationId !== undefined) {
        const preflight = chat.getContextStatus(
          conversationId,
          contextBudgetPolicy,
          undefined,
          line,
        );
        if (preflight.hardLimitReached || hardBlocked) {
          inputController.captureDraft(rawLine);
          startCompaction("automatic", true);
          continue;
        }
      }
      context.output.write("主笔：");
      try {
        const result = await generateOnce(context, chat, {
          projectId: options.projectId,
          provider,
          model,
          prompt: line,
          ...(conversationId === undefined ? {} : { conversationId }),
          approveToolCall: (request) => approveProjectWrite(context, chat, readline, request),
          contextBudgetPolicy,
          ...(options.onDebugEvent === undefined ? {} : { onDebugEvent: options.onDebugEvent }),
        });
        conversationId = result.conversationId;
        const budget = chat.getContextStatus(conversationId, contextBudgetPolicy);
        if (budget.softLimitReached) startCompaction("automatic", budget.hardLimitReached);
      } catch (error) {
        const appError = asAppError(error);
        const failedConversationId = appError.details?.conversationId;
        if (typeof failedConversationId === "string") conversationId = failedConversationId;
        if (!isRecoverableChatError(appError)) throw appError;
        context.output.write("\n");
        printRecoverableChatError(context, appError);
      }
    }
  } finally {
    const pending = compaction as { promise: Promise<void>; controller: AbortController } | null;
    if (pending !== null) {
      pending.controller.abort();
      await pending.promise;
    }
    readline.close();
    context.output.write("聊天记录已保存在当前项目中。\n");
  }
}

function printContextStatus(
  context: CliCommandContext,
  status: ReturnType<ChatService["getContextStatus"]>,
): void {
  context.output.write(`预计输入：${status.estimatedInputTokens} tokens\n`);
  context.output.write(`可用预算：${status.effectiveLimitTokens} tokens\n`);
  context.output.write(`占用比例：${(status.ratio * 100).toFixed(1)}%\n`);
  context.output.write(
    `状态：${status.hardLimitReached ? "硬限制" : status.softLimitReached ? "需要压缩" : "正常"}\n`,
  );
}

function printProjectInstructions(
  context: CliCommandContext,
  revision: ReturnType<ChatService["getProjectInstructions"]>,
): void {
  if (revision === null) {
    context.output.write("当前项目尚未设置项目指令（Revision 0）。\n");
    return;
  }
  context.output.write(
    `项目指令 Revision ${revision.revision}\nSHA-256：${revision.contentHash}\n更新时间：${revision.createdAt}\n\n${sanitizeTerminalMultiline(revision.content)}\n`,
  );
}

function printProjectInstructionHistory(
  context: CliCommandContext,
  revisions: ReturnType<ChatService["listProjectInstructionHistory"]>,
): void {
  if (revisions.length === 0) {
    context.output.write("项目指令没有历史 Revision。\n");
    return;
  }
  for (const revision of revisions) {
    context.output.write(
      `Revision ${revision.revision}\t${revision.createdAt}\t${revision.contentHash}\t${revision.content.length} 字符\n`,
    );
  }
}

function printSessions(
  context: CliCommandContext,
  sessions: ReturnType<ChatService["getSessions"]>,
): void {
  for (const session of sessions) {
    context.output.write(
      `[${session.ordinal}] ${session.status} | ${session.trigger} | ${session.startedAt}${session.closedAt === null ? "" : ` → ${session.closedAt}`}\n`,
    );
  }
}

function printSession(
  context: CliCommandContext,
  details: ReturnType<ChatService["getSessionDetails"]>,
): void {
  const { session } = details;
  context.output.write(`Session ${session.ordinal} (${session.status})\n`);
  context.output.write(`ID：${session.id}\n触发：${session.trigger}\n开始：${session.startedAt}\n`);
  context.output.write(`结束：${session.closedAt ?? "未结束"}\n`);
  context.output.write(`继承摘要：${session.inheritedSummaryId ?? "无"}\n`);
  context.output.write(
    `消息范围：${details.firstMessageId ?? "无"} → ${details.lastMessageId ?? "无"}（${details.messageCount} 条）\n`,
  );
  if (details.summary !== null) context.output.write(`累计摘要：${details.summary.summary}\n`);
}

async function restoreProjectInstructions(
  context: CliCommandContext,
  chat: ChatService,
  readline: Interface,
  line: string,
): Promise<void> {
  const revision = Number(line.slice("/instructions restore ".length).trim());
  if (!Number.isSafeInteger(revision) || revision <= 0) {
    context.output.write("项目指令 Revision 必须是正整数。\n");
    return;
  }
  const target = chat.listProjectInstructionHistory(500).find((item) => item.revision === revision);
  if (target === undefined) {
    context.output.write(`找不到项目指令 Revision ${revision}。\n`);
    return;
  }
  const current = chat.getProjectInstructions();
  context.output.write(
    `${sanitizeTerminalMultiline(createInstructionDiff(current?.content ?? "", target.content))}\n`,
  );
  const answer = (await readline.question(`恢复 Revision ${revision}？[y/N] `))
    .trim()
    .toLowerCase();
  if (answer === "y" || answer === "yes") {
    const restored = await chat.restoreProjectInstructions(revision, current?.revision ?? 0);
    context.output.write(`已恢复为新的 Revision ${restored.revision}。\n`);
  } else context.output.write("已取消恢复。\n");
}

async function approveProjectWrite(
  context: CliCommandContext,
  chat: ChatService,
  readline: Interface,
  request: ToolApprovalRequest,
): Promise<ApprovalChoice> {
  const toolInput = isRecord(request.input) ? request.input : {};
  if (request.toolName === "append_project_instructions") {
    const current = chat.getProjectInstructions()?.content ?? "";
    const text = typeof toolInput.text === "string" ? toolInput.text : "";
    context.output.write(`\nLLM 请求追加项目指令（Tool v${request.toolVersion}）：\n`);
    context.output.write(
      `${sanitizeTerminalMultiline(createInstructionDiff(current, current + text))}\n`,
    );
    return askToolApproval(readline, "允许项目指令追加？");
  }
  if (request.toolName === "set_project_instructions") {
    const current = chat.getProjectInstructions()?.content ?? "";
    const content = typeof toolInput.content === "string" ? toolInput.content : "";
    context.output.write(`\nLLM 请求整体替换项目指令（Tool v${request.toolVersion}）：\n`);
    context.output.write(`${sanitizeTerminalMultiline(createInstructionDiff(current, content))}\n`);
    return askToolApproval(readline, "允许整体替换项目指令？");
  }
  if (request.toolName !== "write_project_document") {
    context.output.write(`\nLLM 请求执行 ${request.toolName} v${request.toolVersion}。\n`);
    return askToolApproval(readline, "允许执行？");
  }
  const path = typeof toolInput.path === "string" ? toolInput.path : "";
  const content = typeof toolInput.content === "string" ? toolInput.content : "";
  const overwrite = toolInput.overwrite === true;
  context.output.write(`\nLLM 请求${overwrite ? "覆盖" : "创建"}项目文档：${path}\n`);
  context.output.write(`内容长度：${content.length} 字符\n`);
  const preview = sanitizeTerminalText(content.slice(0, 240));
  if (preview !== "") context.output.write(`内容预览：${truncateText(preview, 240)}\n`);
  return askToolApproval(readline, "允许写入？");
}

async function askToolApproval(readline: Interface, prompt: string): Promise<ApprovalChoice> {
  const answer = (await readline.question(`${prompt}[y]仅本次/[a]退出前允许/[N]拒绝 `))
    .trim()
    .toLowerCase();
  if (answer === "y" || answer === "yes") return "allow_once";
  if (answer === "a" || answer === "always") return "allow_until_exit";
  return "reject";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
