import type {
  ChunkDocumentOptions,
  ChunkTokenizer,
  LanguageDetectionOptions,
} from "@cleodoc/document-ingestion";
import type { MaterialInputEncoding } from "./text-decoding.js";
import type {
  KnowledgeSourceIndexStatus,
  KnowledgeSourceLanguage,
  VectorSearchHit,
} from "../../contracts/src/index.js";

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
  readonly modelName: string;
  readonly modelRevision: string;
  readonly maxInputTokens: number;
  openTokenizer(): Promise<DisposableChunkTokenizer>;
}

export interface MaterialEmbeddingChunk {
  readonly chunkId: string;
  readonly content: string;
}

export interface MaterialEmbeddingChunkResult {
  readonly chunkId: string;
  readonly tokenCount: number;
  readonly vector: Float32Array;
}

export interface MaterialEmbeddingTaskProgress {
  readonly completedChunks: number;
  readonly totalChunks: number;
  readonly chunkId: string;
}

export interface MaterialEmbeddingTaskOptions {
  readonly chunks: readonly MaterialEmbeddingChunk[];
  readonly chunkBatchSize: number;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: MaterialEmbeddingTaskProgress) => void;
  readonly onBatch?: (results: readonly MaterialEmbeddingChunkResult[]) => void | Promise<void>;
}

export interface MaterialEmbeddingModel extends MaterialTokenizerModel {
  runEmbeddingTask(options: MaterialEmbeddingTaskOptions): Promise<void>;
  embedQuery(
    query: string,
  ): Promise<{ readonly vector: Float32Array; readonly tokenCount: number }>;
}

export interface MaterialEmbeddingIndexProgress extends MaterialEmbeddingTaskProgress {
  readonly language: "zh" | "en";
  readonly modelId: string;
}

export interface MaterialEmbeddingModelResult {
  readonly language: "zh" | "en";
  readonly modelId: string;
  readonly totalChunks: number;
  readonly processedChunks: number;
  readonly skippedChunks: number;
  readonly writtenChunks: number;
  readonly discardedChunks: number;
  readonly failedChunks: number;
  readonly tokenCount: number;
  readonly dimensions: number | null;
  readonly durationMs: number;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
}

export interface MaterialEmbeddingIndexResult {
  readonly totalChunks: number;
  readonly processedChunks: number;
  readonly skippedChunks: number;
  readonly writtenChunks: number;
  readonly discardedChunks: number;
  readonly failedChunks: number;
  readonly models: readonly MaterialEmbeddingModelResult[];
}

export interface MaterialEmbeddingIndexOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: MaterialEmbeddingIndexProgress) => void;
  readonly continueOnError?: boolean;
}

export interface MaterialIndexDiagnostic extends KnowledgeSourceIndexStatus {
  readonly language: KnowledgeSourceLanguage;
  readonly embeddingModelId: string;
  readonly embeddedChunkCount: number;
  readonly pendingEmbeddingCount: number;
}

export interface MaterialSemanticSearchResult {
  readonly language: KnowledgeSourceLanguage;
  readonly modelId: string;
  readonly tokenCount: number;
  readonly dimensions: number;
  readonly embeddingDurationMs: number;
  readonly searchDurationMs: number;
  readonly results: readonly VectorSearchHit[];
}

export interface MaterialServiceOptions {
  readonly database: { busyTimeoutMs: number };
  readonly maxImportBytes: number;
  readonly chunking: ChunkDocumentOptions;
  readonly languageDetection: LanguageDetectionOptions;
  readonly embeddingChunkBatchSize: number;
  readonly embeddingModels: Readonly<Record<"zh" | "en", MaterialEmbeddingModel>>;
}
