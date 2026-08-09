import path from "node:path";

import { AppError } from "../../contracts/src/index.js";
import type {
  EmbeddingInputKind,
  EmbeddingLanguage,
  EmbeddingModelDefinition,
  ResolvedEmbeddingModelDefinition,
} from "./embedding-types.js";

export function resolveEmbeddingModelDefinition(
  language: EmbeddingLanguage,
  definition: EmbeddingModelDefinition,
  resourceRoot: string,
): ResolvedEmbeddingModelDefinition {
  const root = path.resolve(resourceRoot);
  const modelPath = path.resolve(root, definition.modelFile);
  const relative = path.relative(root, modelPath);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new AppError("CONFIG_ERROR", "Embedding 模型文件必须位于应用资源目录中。");
  }
  return { ...definition, language, modelPath };
}

export function formatEmbeddingInput(
  definition: EmbeddingModelDefinition,
  kind: EmbeddingInputKind,
  content: string,
): string {
  if (content.trim() === "") {
    throw new AppError("VALIDATION_ERROR", "Embedding 输入不能为空。");
  }
  return kind === "query" ? `${definition.queryPrefix}${content}` : content;
}
