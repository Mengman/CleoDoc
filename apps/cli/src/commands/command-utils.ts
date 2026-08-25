import { AppError, type SavedDocument } from "../../../../packages/contracts/src/index.js";
import { optionString, type ParsedArguments } from "../arguments.js";
import type { CliCommandContext } from "./command-context.js";

export function optionPositiveInteger(parsed: ParsedArguments, name: string): number | undefined {
  const value = optionString(parsed, name);
  if (value === undefined) return undefined;
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

export function parsePositiveEnvironmentInteger(name: string): number | undefined {
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

export function installInterruptHandler(
  context: CliCommandContext,
  controller: AbortController,
): () => void {
  const handler = (): void => {
    if (!controller.signal.aborted) {
      context.output.write("\n正在取消生成……\n");
      controller.abort();
    }
  };
  process.once("SIGINT", handler);
  return () => process.off("SIGINT", handler);
}

export function printSaved(context: CliCommandContext, saved: SavedDocument): void {
  context.output.write(`${saved.created ? "已创建" : "已覆盖"}：${saved.relativePath}\n`);
  context.output.write(`内容哈希：${saved.contentHash}\n`);
}
