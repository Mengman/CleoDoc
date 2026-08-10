import { describe, expect, it } from "vitest";

import type { RetrievedChunk } from "../../contracts/src/index.js";
import { fuseAndSelectHybridResults } from "./hybrid-retrieval.js";

describe("hybrid retrieval", () => {
  it("uses RRF to combine exact, FTS, and vector ranks deterministically", () => {
    const first = hit("first", "source-a", 0, 10);
    const second = hit("second", "source-b", 0, 10);
    const selection = fuseAndSelectHybridResults(
      {
        exact: [first],
        fts: [second, first],
        vector: [{ chunk: second, distance: 0.1 }],
      },
      options(),
    );

    expect(selection.results.map((result) => result.chunk.chunkId)).toEqual(["second", "first"]);
    expect(selection.results[0]).toMatchObject({
      ranks: [
        { method: "fts", rank: 1 },
        { method: "vector", rank: 1 },
      ],
      vectorDistance: 0.1,
    });
  });

  it("removes overlapping chunks and enforces source and context budgets", () => {
    const selection = fuseAndSelectHybridResults(
      {
        exact: [
          hit("a-1", "source-a", 0, 60, "a".repeat(60)),
          hit("a-overlap", "source-a", 5, 55, "a".repeat(50)),
          hit("a-2", "source-a", 70, 100, "a".repeat(30)),
          hit("b-1", "source-b", 0, 40, "b".repeat(40)),
          hit("b-too-large", "source-b", 50, 120, "b".repeat(70)),
        ],
        fts: [],
        vector: [],
      },
      { ...options(), contextMaxCharacters: 100, maxSourceRatio: 0.6 },
    );

    expect(selection.results.map((result) => result.chunk.chunkId)).toEqual(["a-1", "b-1"]);
    expect(selection.contentCharacterCount).toBe(100);
  });
});

function options() {
  return { rrfK: 60, resultLimit: 5, contextMaxCharacters: 1_000, maxSourceRatio: 0.6 };
}

function hit(
  chunkId: string,
  sourceId: string,
  startOffset: number,
  endOffset: number,
  content = chunkId,
): RetrievedChunk {
  return {
    chunkId,
    sourceId,
    content,
    startOffset,
    endOffset,
    sourceTitle: sourceId,
    sourceRevision: `${sourceId}-revision`,
    sourceUpdatedAt: "2026-08-10T00:00:00.000Z",
  };
}
