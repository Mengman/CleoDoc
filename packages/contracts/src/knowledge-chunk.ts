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

export interface RetrievedChunk {
  readonly chunkId: string;
  readonly sourceId: string;
  readonly content: string;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly sourceTitle: string;
  readonly sourceRevision: string;
  readonly sourceUpdatedAt: string;
}

export interface KnowledgeSearchFilter {
  readonly projectId: string;
  readonly sourceType: "material";
  readonly sourceId?: string;
  readonly sourceRevision?: string;
}
