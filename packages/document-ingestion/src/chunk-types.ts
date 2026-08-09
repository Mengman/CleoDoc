import type { ParsedDocument, SourceRange } from "./types.js";

export interface ChunkDocumentOptions {
  readonly splitSearchWindowRatio: number;
}

export interface ChunkTokenizer {
  readonly modelId: string;
  readonly modelRevision: string;
  readonly maxInputTokens: number;

  countDocumentTokens(content: string): number;
}

export interface ChunkingConfigSnapshot extends ChunkDocumentOptions {
  readonly tokenizerModelId: string;
  readonly tokenizerRevision: string;
  readonly maxInputTokens: number;
}

export interface ChunkDraft extends SourceRange {
  readonly ordinal: number;
  readonly content: string;
  readonly characterCount: number;
  readonly tokenCount: number;
  readonly blockTypes: readonly string[];
}

export interface ChunkedDocument {
  readonly chunkerVersion: string;
  readonly parserVersion: string;
  readonly sourceByteLength: number;
  readonly config: ChunkingConfigSnapshot;
  readonly chunks: readonly ChunkDraft[];
}

export interface ChunkDocumentInput {
  readonly parsedDocument: ParsedDocument;
  readonly sourceContent: string;
}
