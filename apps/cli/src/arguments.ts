import type { ZodType } from "zod";

import { AppError } from "../../../packages/contracts/src/index.js";

export interface ParsedArguments {
  command: string | undefined;
  positionals: readonly string[];
  options: ReadonlyMap<string, string | true>;
}

export function parseArguments(argumentsList: readonly string[]): ParsedArguments {
  const [command, ...remaining] = argumentsList;
  const positionals: string[] = [];
  const options = new Map<string, string | true>();

  for (let index = 0; index < remaining.length; index += 1) {
    const value = remaining[index];
    if (value === undefined) {
      continue;
    }
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }

    const equalsIndex = value.indexOf("=");
    if (equalsIndex > 2) {
      options.set(value.slice(2, equalsIndex), value.slice(equalsIndex + 1));
      continue;
    }

    const name = value.slice(2);
    const next = remaining[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      options.set(name, next);
      index += 1;
    } else {
      options.set(name, true);
    }
  }

  return { command, positionals, options };
}

export function optionString(parsed: ParsedArguments, name: string): string | undefined {
  const value = parsed.options.get(name);
  if (value === true) {
    throw new AppError("VALIDATION_ERROR", `--${name} 需要一个值。`);
  }
  return value;
}

export function optionBoolean(parsed: ParsedArguments, name: string): boolean {
  const value = parsed.options.get(name);
  if (value === undefined) {
    return false;
  }
  if (value !== true) {
    throw new AppError("VALIDATION_ERROR", `--${name} 是布尔开关，不能带值。`);
  }
  return true;
}

export function assertOnlyOptions(parsed: ParsedArguments, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  const unexpected = [...parsed.options.keys()].filter((option) => !allowedSet.has(option));
  if (unexpected.length > 0) {
    throw new AppError(
      "VALIDATION_ERROR",
      `未知选项：${unexpected.map((x) => `--${x}`).join(", ")}`,
    );
  }
}

export function validateInput<T>(schema: ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new AppError("VALIDATION_ERROR", "命令参数无效。", {
      details: {
        issues: result.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
    });
  }
  return result.data;
}
