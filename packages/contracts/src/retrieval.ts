import type { RetrievedChunk } from "./knowledge-chunk.js";

export type RetrievalMethod = "exact" | "fts" | "vector";

export interface RetrievalFilter {
  readonly sourceType: "material";
  readonly sourceId?: string;
  readonly sourceRevision?: string;
}

export interface RetrievalRank {
  readonly method: RetrievalMethod;
  readonly rank: number;
}

export interface RetrievalCandidate {
  readonly chunk: RetrievedChunk;
  readonly score: number;
  readonly ranks: readonly RetrievalRank[];
  readonly vectorDistance: number | null;
}

export interface RetrievalContext {
  readonly items: readonly RetrievalCandidate[];
  readonly contentCharacterCount: number;
}

export interface HybridRetrievalResult {
  readonly language: "zh" | "en";
  readonly embeddingModelId: string;
  readonly queryTokenCount: number | null;
  readonly exactCandidateCount: number;
  readonly ftsCandidateCount: number;
  readonly vectorCandidateCount: number;
  readonly embeddingDurationMs: number;
  readonly retrievalDurationMs: number;
  readonly vectorErrorCode: string | null;
  readonly retrievalContext: RetrievalContext;
}
