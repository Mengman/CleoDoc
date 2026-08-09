export type KnowledgeIndexStatus = "pending" | "ready" | "stale" | "failed";

export interface KnowledgeChunk {
  readonly chunkId: string;
  readonly sourceId: string;
  readonly ordinal: number;
  readonly content: string;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly chunkerVersion: string;
  readonly createdAt: string;
}

export interface KnowledgeSourceIndexStatus {
  readonly sourceId: string;
  readonly title: string;
  readonly status: KnowledgeIndexStatus;
  readonly chunkCount: number;
  readonly parserVersion: string | null;
  readonly chunkerVersion: string | null;
  readonly indexedAt: string | null;
  readonly errorCode: string | null;
}

export interface KnowledgeSearchResult extends KnowledgeChunk {
  readonly sourceTitle: string;
  readonly sourceLabel: string | null;
}
