import type { RetrievedChunk } from "./knowledge-chunk.js";

export interface VectorSearchFilter {
  readonly projectId: string;
  readonly sourceType: "material";
  readonly sourceId?: string;
  readonly sourceRevision?: string;
  readonly embeddingModelName: string;
  readonly embeddingModelRevision: string;
}

export interface VectorSearchHit {
  readonly chunk: RetrievedChunk;
  readonly distance: number;
}

export interface VectorIndex {
  search(
    query: Float32Array,
    filter: VectorSearchFilter,
    limit: number,
  ): Promise<readonly VectorSearchHit[]>;
}
