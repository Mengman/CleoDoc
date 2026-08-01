import { mkdir, open, type FileHandle } from "node:fs/promises";
import path from "node:path";

import type { LlmDebugEvent, LlmDebugHandler } from "../../../packages/agent/src/index.js";
import { AppError } from "../../../packages/contracts/src/index.js";

export class LlmDebugFileLogger {
  readonly onEvent: LlmDebugHandler;
  private pendingWrite: Promise<void> = Promise.resolve();
  private writeError: unknown;

  private constructor(
    readonly filePath: string,
    private readonly file: FileHandle,
  ) {
    this.onEvent = (event) => this.enqueue(event);
  }

  static async create(projectRoot: string): Promise<LlmDebugFileLogger> {
    const directory = path.join(projectRoot, ".cleo", "logs");
    await mkdir(directory, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filePath = path.join(directory, `cleodoc-debug-${timestamp}-${process.pid}.log`);
    const file = await open(filePath, "wx", 0o600);
    const logger = new LlmDebugFileLogger(filePath, file);
    await file.writeFile(
      `CleoDoc LLM debug log\nstartedAt=${new Date().toISOString()}\n` +
        "WARNING: request bodies may contain private project content. Authentication headers are redacted.\n\n",
      "utf8",
    );
    return logger;
  }

  async close(): Promise<void> {
    await this.pendingWrite;
    await this.file.close();
    if (this.writeError !== undefined) {
      throw new AppError("IO_ERROR", "Debug 日志写入失败。", {
        cause: this.writeError,
        details: { filePath: this.filePath },
      });
    }
  }

  private enqueue(event: LlmDebugEvent): void {
    const entry = formatLlmDebugEvent(event);
    this.pendingWrite = this.pendingWrite.then(async () => {
      if (this.writeError !== undefined) return;
      try {
        await this.file.appendFile(entry, "utf8");
      } catch (error) {
        this.writeError = error;
      }
    });
  }
}

export function formatLlmDebugEvent(event: LlmDebugEvent): string {
  const timestamp = new Date().toISOString();
  const operation = operationLabel(event.operation);
  if (event.type === "llm-protocol") {
    const protocol = event.protocol;
    if (protocol.type === "request") {
      return rawBlock(
        timestamp,
        `${operation} LLM 请求 #${event.round}`,
        `${protocol.method} ${protocol.url}\nheaders: ${JSON.stringify(protocol.headers)}\nbody:\n${protocol.body}`,
      );
    }
    if (protocol.type === "response-head") {
      return rawBlock(
        timestamp,
        `${operation} LLM 响应头 #${event.round}`,
        `HTTP ${protocol.status}${protocol.statusText === "" ? "" : ` ${protocol.statusText}`}\nheaders: ${JSON.stringify(protocol.headers)}`,
      );
    }
    return rawBlock(timestamp, `${operation} LLM 原始响应块 #${event.round}`, protocol.chunk);
  }

  if (event.type === "llm-response") {
    const source = event.contextSource === "provider" ? "API" : "本地估算";
    return `[${timestamp}] [debug] ${operation} LLM 响应 #${event.round}：context=${event.contextTokens} tokens（${source}），本地估算=${event.estimatedContextTokens}，output=${event.outputTokens ?? "未知"}，reasoning=${event.reasoningTokens ?? "未知"}，total=${event.totalTokens ?? "未知"}，finish=${event.finishReason ?? "未知"}\n`;
  }

  const details = event.details === null ? "" : `\n错误详情：${JSON.stringify(event.details)}`;
  return `[${timestamp}] [debug] ${operation} LLM 响应 #${event.round} 解析/验证失败 [${event.errorCode}]：${event.message}${details}\n`;
}

function operationLabel(operation: LlmDebugEvent["operation"]): string {
  return operation === "agent" ? "主笔" : operation === "compaction" ? "上下文压缩" : "压缩修复";
}

function rawBlock(timestamp: string, label: string, value: string): string {
  const safeValue = sanitizeRawProtocolText(value);
  return `[${timestamp}] [debug][raw] ===== ${label} =====\n${safeValue}${safeValue.endsWith("\n") ? "" : "\n"}[${timestamp}] [debug][raw] ===== ${label} 结束 =====\n`;
}

function sanitizeRawProtocolText(value: string): string {
  return [...value.replace(/\r\n/g, "\n")]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      if (codePoint === 9 || codePoint === 10) return character;
      if (codePoint <= 31 || (codePoint >= 127 && codePoint <= 159)) {
        return `\\u${codePoint.toString(16).padStart(4, "0")}`;
      }
      return character;
    })
    .join("");
}
