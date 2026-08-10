import type {
  RetrievalCandidate,
  RetrievalMethod,
  RetrievalRank,
  RetrievedChunk,
  VectorSearchHit,
} from "../../contracts/src/index.js";

export interface HybridFusionOptions {
  readonly rrfK: number;
  readonly resultLimit: number;
  readonly contextMaxCharacters: number;
  readonly maxSourceRatio: number;
}

export interface HybridCandidateSets {
  readonly exact: readonly RetrievedChunk[];
  readonly fts: readonly RetrievedChunk[];
  readonly vector: readonly VectorSearchHit[];
}

export interface HybridSelection {
  readonly results: readonly RetrievalCandidate[];
  readonly contentCharacterCount: number;
}

interface MutableCandidate {
  chunk: RetrievedChunk;
  score: number;
  ranks: RetrievalRank[];
  vectorDistance: number | null;
}

export function fuseAndSelectHybridResults(
  candidates: HybridCandidateSets,
  options: HybridFusionOptions,
): HybridSelection {
  validateOptions(options);
  const fused = fuseCandidates(candidates, options.rrfK);
  const sourceCount = new Set(fused.map((candidate) => candidate.chunk.sourceId)).size;
  const maxSourceCharacters =
    sourceCount > 1
      ? Math.max(1, Math.floor(options.contextMaxCharacters * options.maxSourceRatio))
      : options.contextMaxCharacters;
  const results: RetrievalCandidate[] = [];
  const sourceCharacters = new Map<string, number>();
  let contentCharacterCount = 0;

  for (const candidate of fused) {
    if (results.length >= options.resultLimit) break;
    if (results.some((hit) => substantiallyOverlaps(hit, candidate))) continue;

    const characters = Array.from(candidate.chunk.content).length;
    if (contentCharacterCount + characters > options.contextMaxCharacters) continue;
    if ((sourceCharacters.get(candidate.chunk.sourceId) ?? 0) + characters > maxSourceCharacters) {
      continue;
    }

    results.push(candidate);
    contentCharacterCount += characters;
    sourceCharacters.set(
      candidate.chunk.sourceId,
      (sourceCharacters.get(candidate.chunk.sourceId) ?? 0) + characters,
    );
  }

  return { results, contentCharacterCount };
}

function fuseCandidates(candidates: HybridCandidateSets, rrfK: number): RetrievalCandidate[] {
  const byChunk = new Map<string, MutableCandidate>();
  addRankedChunks(byChunk, "exact", candidates.exact, rrfK);
  addRankedChunks(byChunk, "fts", candidates.fts, rrfK);
  addRankedVectorHits(byChunk, candidates.vector, rrfK);

  return [...byChunk.values()]
    .map(({ chunk, score, ranks, vectorDistance }) => ({
      chunk,
      score,
      ranks: [...ranks].sort((left, right) => methodOrder(left.method) - methodOrder(right.method)),
      vectorDistance,
    }))
    .sort(
      (left, right) =>
        right.score - left.score ||
        bestRank(left.ranks) - bestRank(right.ranks) ||
        left.chunk.chunkId.localeCompare(right.chunk.chunkId),
    );
}

function addRankedChunks(
  target: Map<string, MutableCandidate>,
  method: "exact" | "fts",
  chunks: readonly RetrievedChunk[],
  rrfK: number,
): void {
  chunks.forEach((chunk, index) => addRank(target, method, chunk, index + 1, rrfK, null));
}

function addRankedVectorHits(
  target: Map<string, MutableCandidate>,
  hits: readonly VectorSearchHit[],
  rrfK: number,
): void {
  hits.forEach((hit, index) => addRank(target, "vector", hit.chunk, index + 1, rrfK, hit.distance));
}

function addRank(
  target: Map<string, MutableCandidate>,
  method: RetrievalMethod,
  chunk: RetrievedChunk,
  rank: number,
  rrfK: number,
  vectorDistance: number | null,
): void {
  const current = target.get(chunk.chunkId) ?? {
    chunk,
    score: 0,
    ranks: [],
    vectorDistance: null,
  };
  current.score += 1 / (rrfK + rank);
  current.ranks.push({ method, rank });
  if (vectorDistance !== null) current.vectorDistance = vectorDistance;
  target.set(chunk.chunkId, current);
}

function substantiallyOverlaps(left: RetrievalCandidate, right: RetrievalCandidate): boolean {
  if (left.chunk.sourceId !== right.chunk.sourceId) return false;
  const overlap = Math.max(
    0,
    Math.min(left.chunk.endOffset, right.chunk.endOffset) -
      Math.max(left.chunk.startOffset, right.chunk.startOffset),
  );
  const shorterLength = Math.min(
    left.chunk.endOffset - left.chunk.startOffset,
    right.chunk.endOffset - right.chunk.startOffset,
  );
  return shorterLength > 0 && overlap / shorterLength >= 0.8;
}

function bestRank(ranks: readonly RetrievalRank[]): number {
  return Math.min(...ranks.map((rank) => rank.rank));
}

function methodOrder(method: RetrievalMethod): number {
  return method === "exact" ? 0 : method === "fts" ? 1 : 2;
}

function validateOptions(options: HybridFusionOptions): void {
  if (!Number.isFinite(options.rrfK) || options.rrfK <= 0) {
    throw new Error("rrfK must be positive");
  }
  if (!Number.isInteger(options.resultLimit) || options.resultLimit <= 0) {
    throw new Error("resultLimit must be a positive integer");
  }
  if (!Number.isInteger(options.contextMaxCharacters) || options.contextMaxCharacters <= 0) {
    throw new Error("contextMaxCharacters must be a positive integer");
  }
  if (options.maxSourceRatio <= 0 || options.maxSourceRatio > 1) {
    throw new Error("maxSourceRatio must be in (0, 1]");
  }
}
