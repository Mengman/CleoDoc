export type EmbeddingLanguage = "zh" | "en";
export type EmbeddingInputKind = "document" | "query";

export interface EmbeddingModelDefinition {
  readonly modelId: string;
  readonly modelName: string;
  readonly revision: string;
  readonly modelFile: string;
  readonly maxInputTokens: number;
  readonly queryPrefix: string;
}

export interface ResolvedEmbeddingModelDefinition extends EmbeddingModelDefinition {
  readonly language: EmbeddingLanguage;
  readonly modelPath: string;
}

export interface EmbeddingTokenizer {
  readonly modelId: string;
  readonly modelRevision: string;
  readonly maxInputTokens: number;

  countDocumentTokens(content: string): number;
  countQueryTokens(query: string): number;
}

export interface DisposableEmbeddingTokenizer extends EmbeddingTokenizer {
  dispose(): Promise<void>;
}

export interface EmbeddingResult {
  readonly vector: Float32Array;
  readonly tokenCount: number;
}

export interface EmbeddingRuntimeInfo {
  readonly modelId: string;
  readonly modelName: string;
  readonly revision: string;
  readonly language: EmbeddingLanguage;
  readonly modelPath: string;
  readonly maxInputTokens: number;
  readonly embeddingDimensions: number;
  readonly modelWarnings: readonly string[];
}
