import type { ParsedDocument, SourceRange } from "./types.js";

export interface ChunkDocumentOptions {
  readonly maxChunkChars: number;
  readonly splitSearchWindowRatio: number;
}

export interface ChunkDraft extends SourceRange {
  readonly ordinal: number;
  readonly content: string;
  readonly characterCount: number;
  readonly blockTypes: readonly string[];
}

export interface ChunkedDocument {
  readonly chunkerVersion: string;
  readonly parserVersion: string;
  readonly sourceByteLength: number;
  readonly config: ChunkDocumentOptions;
  readonly chunks: readonly ChunkDraft[];
}

export interface ChunkDocumentInput {
  readonly parsedDocument: ParsedDocument;
  readonly sourceContent: string;
}
