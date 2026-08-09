import type { AppErrorCode } from "../../contracts/src/index.js";
import type {
  EmbeddingChunkInput,
  EmbeddingChunkResult,
  EmbeddingRuntimeInfo,
  ResolvedEmbeddingModelDefinition,
} from "./embedding-types.js";

export type EmbeddingWorkerRequest =
  | {
      readonly type: "initialize";
      readonly definition: ResolvedEmbeddingModelDefinition;
      readonly gpuAcceleration: boolean;
      readonly totalChunks: number;
    }
  | {
      readonly type: "embed_batch";
      readonly batchId: number;
      readonly chunks: readonly EmbeddingChunkInput[];
    }
  | { readonly type: "dispose" };

export type EmbeddingWorkerResponse =
  | { readonly type: "ready"; readonly info: EmbeddingRuntimeInfo }
  | {
      readonly type: "progress";
      readonly completedChunks: number;
      readonly totalChunks: number;
      readonly chunkId: string;
    }
  | {
      readonly type: "batch_complete";
      readonly batchId: number;
      readonly results: readonly EmbeddingChunkResult[];
    }
  | { readonly type: "disposed" }
  | { readonly type: "error"; readonly error: SerializedEmbeddingWorkerError };

export interface SerializedEmbeddingWorkerError {
  readonly code: AppErrorCode;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export function isEmbeddingWorkerResponse(value: unknown): value is EmbeddingWorkerResponse {
  if (typeof value !== "object" || value === null) return false;
  const type = Reflect.get(value, "type");
  return (
    type === "ready" ||
    type === "progress" ||
    type === "batch_complete" ||
    type === "disposed" ||
    type === "error"
  );
}
