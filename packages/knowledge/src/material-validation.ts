import { createHash } from "node:crypto";
import path from "node:path";

import {
  AppError,
  knowledgeSourceSchema,
  type KnowledgeSource,
} from "../../contracts/src/index.js";

export function materialFormatFromPath(filePath: string): KnowledgeSource["format"] {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".txt") {
    return "text";
  }
  if (extension === ".md" || extension === ".markdown") {
    return "markdown";
  }
  throw new AppError("VALIDATION_ERROR", "步骤 5 仅支持 TXT、MD 和 Markdown 文件。");
}

export function assertMaterialContent(content: string, maxImportBytes: number): void {
  const size = Buffer.byteLength(content, "utf8");
  if (size === 0) {
    throw new AppError("VALIDATION_ERROR", "资料内容不能为空。");
  }
  if (size > maxImportBytes) {
    throw new AppError("VALIDATION_ERROR", "单份资料超过了软件配置允许的大小。");
  }
}

export function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function normalizeTitle(title: string): string {
  const normalized = title.trim();
  if (normalized.length === 0 || normalized.length > 200) {
    throw new AppError("VALIDATION_ERROR", "资料标题长度必须为 1–200 个字符。");
  }
  return normalized;
}

export function normalizeTags(tags: readonly string[]): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const tag of tags) {
    const value = tag.trim();
    if (value === "") {
      continue;
    }
    if (value.length > 100) {
      throw new AppError("VALIDATION_ERROR", "单个资料标签不能超过 100 个字符。");
    }
    const key = value.toLocaleLowerCase("zh-CN");
    if (!seen.has(key)) {
      seen.add(key);
      normalized.push(value);
    }
  }
  if (normalized.length > 100) {
    throw new AppError("VALIDATION_ERROR", "单份资料不能超过 100 个标签。");
  }
  return normalized;
}

export function defaultPastedTitle(): string {
  return `粘贴资料 ${new Date().toLocaleString("zh-CN", { hour12: false })}`;
}

export function materialNotFound(id: string): AppError {
  return new AppError("MATERIAL_NOT_FOUND", "找不到指定资料。", {
    details: { materialId: id },
  });
}

export function parseKnowledgeSource(
  value: unknown,
  message = "资料元数据无效。",
): KnowledgeSource {
  const parsed = knowledgeSourceSchema.safeParse(value);
  if (!parsed.success) {
    throw new AppError("VALIDATION_ERROR", message, {
      details: {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
    });
  }
  return parsed.data;
}
