import { emitKeypressEvents, type Key } from "node:readline";

import type { ChatService } from "../../../../packages/agent/src/index.js";
import {
  type AppError,
  type ConversationSummary,
} from "../../../../packages/contracts/src/index.js";
import type { CliCommandContext } from "./command-context.js";

export function printRecentConversations(
  context: CliCommandContext,
  conversations: readonly ConversationSummary[],
): void {
  if (conversations.length === 0) {
    context.output.write("最近聊天：暂无记录。\n");
    return;
  }
  context.output.write("最近 5 条聊天记录：\n");
  printConversationChoices(context, conversations);
}

export async function selectConversationFromHistory(
  context: CliCommandContext,
  conversations: readonly ConversationSummary[],
): Promise<ConversationSummary | null> {
  if (conversations.length === 0) {
    context.output.write("尚无聊天记录。\n");
    return null;
  }
  if (!context.input.isTTY || typeof context.input.setRawMode !== "function") {
    context.output.write("聊天历史：\n");
    printConversationChoices(context, conversations);
    context.output.write("当前终端不支持方向键选择，请使用 /resume <序号> 恢复最近记录。\n");
    return null;
  }

  emitKeypressEvents(context.input);
  const previousRawMode = context.input.isRaw;
  let selectedIndex = 0;
  context.output.write("\u001b[?1049h\u001b[?25l");
  context.input.setRawMode(true);
  context.input.resume();

  return new Promise((resolve) => {
    const finish = (selection: ConversationSummary | null): void => {
      context.input.off("keypress", onKeypress);
      context.input.setRawMode(previousRawMode === true);
      context.input.pause();
      context.output.write("\u001b[?25h\u001b[?1049l");
      resolve(selection);
    };
    const render = (): void => {
      const viewportSize = 12;
      const start = Math.max(
        0,
        Math.min(selectedIndex - Math.floor(viewportSize / 2), conversations.length - viewportSize),
      );
      const end = Math.min(conversations.length, start + viewportSize);
      context.output.write("\u001b[2J\u001b[H");
      context.output.write("聊天历史 — ↑/↓ 选择，Enter 恢复，q 退出\n\n");
      for (let index = start; index < end; index += 1) {
        const line = formatConversationChoice(conversations[index]!, index);
        context.output.write(index === selectedIndex ? `\u001b[7m${line}\u001b[0m\n` : `${line}\n`);
      }
      context.output.write(`\n${selectedIndex + 1}/${conversations.length}\n`);
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
    context.input.on("keypress", onKeypress);
    render();
  });
}

export function sanitizeTerminalText(value: string): string {
  return [...value]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159) ? " " : character;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

export function sanitizeTerminalMultiline(value: string): string {
  return [...value]
    .map((character) => {
      if (character === "\n" || character === "\t") return character;
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159) ? " " : character;
    })
    .join("");
}

export function truncateText(value: string, maximumLength: number): string {
  return value.length <= maximumLength ? value : `${value.slice(0, maximumLength - 1)}…`;
}

export function printConversationHistory(
  context: CliCommandContext,
  messages: ReturnType<ChatService["getConversationHistory"]>,
): void {
  if (messages.length === 0) {
    context.output.write("该对话没有消息。\n");
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
    context.output.write(`[${message.createdAt}] ${role}：\n`);
    if (message.toolCalls !== undefined) {
      context.output.write(`[调用工具] ${message.toolCalls.map((call) => call.name).join(", ")}\n`);
    }
    if (message.reasoningContent !== undefined) {
      context.output.write(`思考中：\n${message.reasoningContent}\n`);
      if (message.content !== "") context.output.write("回答：\n");
    }
    if (message.role === "tool") {
      context.output.write(`[${message.name ?? "未知工具"}] ${message.content}\n\n`);
    } else {
      context.output.write(`${message.content}\n\n`);
    }
  }
}

export function isRecoverableChatError(error: AppError): boolean {
  return [
    "PROVIDER_AUTH_ERROR",
    "PROVIDER_RATE_LIMITED",
    "PROVIDER_CONTEXT_LIMIT",
    "PROVIDER_TIMEOUT",
    "PROVIDER_UNAVAILABLE",
    "GENERATION_CANCELLED",
  ].includes(error.code);
}

export function printRecoverableChatError(context: CliCommandContext, error: AppError): void {
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
    context.output.write(`${message}，本轮消息已经保存。聊天仍然保持，可以稍后再次尝试。\n`);
    return;
  }
  if (error.code === "GENERATION_CANCELLED") {
    context.output.write("本轮生成已取消，之前的聊天记录已经保存，可以继续聊天。\n");
    return;
  }
  context.output.write(`模型调用失败 [${error.code}]：${error.message}\n`);
  context.output.write("聊天仍然保持，之前的记录已经保存，可以修正配置后再次尝试。\n");
}

function printConversationChoices(
  context: CliCommandContext,
  conversations: readonly ConversationSummary[],
): void {
  conversations.forEach((conversation, index) => {
    context.output.write(`${formatConversationChoice(conversation, index)}\n`);
  });
}

function formatConversationChoice(conversation: ConversationSummary, index: number): string {
  const title = sanitizeTerminalText(conversation.title ?? "未命名对话");
  const date = new Date(conversation.updatedAt).toLocaleString("zh-CN");
  return `[${index + 1}] ${truncateText(title, 42)} | ${conversation.messageCount} 条 | ${date}`;
}
