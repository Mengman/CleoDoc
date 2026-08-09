import type {
  ChunkDocumentOptions,
  ChunkTokenizer,
  LanguageDetectionOptions,
} from "@cleodoc/document-ingestion";
import type { MaterialInputEncoding } from "./text-decoding.js";

interface MaterialMetadataOptions {
  title?: string;
  sourceLabel?: string;
  tags?: readonly string[];
}

export interface AddFileMaterialOptions extends MaterialMetadataOptions {
  encoding?: MaterialInputEncoding;
}

export interface AddTextMaterialOptions extends MaterialMetadataOptions {
  format?: "text" | "markdown";
}

export interface DisposableChunkTokenizer extends ChunkTokenizer {
  dispose(): Promise<void>;
}

export interface MaterialTokenizerModel {
  readonly modelId: string;
  readonly modelRevision: string;
  readonly maxInputTokens: number;
  openTokenizer(): Promise<DisposableChunkTokenizer>;
}

export interface MaterialServiceOptions {
  readonly database: { busyTimeoutMs: number };
  readonly maxImportBytes: number;
  readonly chunking: ChunkDocumentOptions;
  readonly languageDetection: LanguageDetectionOptions;
  readonly tokenizerModels: Readonly<Record<"zh" | "en", MaterialTokenizerModel>>;
}
