import path from "node:path";

import { describe, expect, it } from "vitest";

import { AppError } from "../../contracts/src/index.js";
import {
  formatEmbeddingInput,
  resolveEmbeddingModelDefinition,
} from "./embedding-model-definition.js";

const definition = {
  modelId: "bge-small-zh-v1.5-q8_0",
  modelName: "BAAI/bge-small-zh-v1.5",
  revision: "v1.5-q8_0",
  modelFile: "models/embedding/bge-small-zh-v1.5-q8_0.gguf",
  maxInputTokens: 512,
  queryPrefix: "为这个句子生成表示以用于检索相关文章：",
} as const;

describe("Embedding model definition", () => {
  it("resolves packaged model files inside the resource root", () => {
    const resourceRoot = path.resolve("resources");
    const resolved = resolveEmbeddingModelDefinition("zh", definition, resourceRoot);

    expect(resolved.language).toBe("zh");
    expect(resolved.modelPath).toBe(
      path.join(resourceRoot, "models/embedding/bge-small-zh-v1.5-q8_0.gguf"),
    );
  });

  it("rejects model paths outside the resource root", () => {
    expect(() =>
      resolveEmbeddingModelDefinition(
        "zh",
        { ...definition, modelFile: "../outside.gguf" },
        path.resolve("resources"),
      ),
    ).toThrowError(AppError);
  });

  it("adds the model-specific instruction only to retrieval queries", () => {
    expect(formatEmbeddingInput(definition, "document", "原始资料")).toBe("原始资料");
    expect(formatEmbeddingInput(definition, "query", "量子通信")).toBe(
      "为这个句子生成表示以用于检索相关文章：量子通信",
    );
  });
});
