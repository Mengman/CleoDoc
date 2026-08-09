import type { KnowledgeSearchResult } from "./knowledge-chunk.js";

export interface VectorSearchFilter {
  readonly projectId: string;
  readonly embeddingModelId: string;
}

export interface VectorSearchHit extends KnowledgeSearchResult {
  readonly distance: number;
}

export interface VectorIndex {
  search(
    query: Float32Array,
    filter: VectorSearchFilter,
    limit: number,
  ): Promise<readonly VectorSearchHit[]>;
}
