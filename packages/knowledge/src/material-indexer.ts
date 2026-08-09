import { performance } from "node:perf_hooks";

import type {
  KnowledgeSearchResult,
  KnowledgeSource,
  KnowledgeSourceLanguage,
  VectorSearchHit,
} from "../../contracts/src/index.js";
import { AppError, asAppError } from "../../contracts/src/index.js";
import {
  ChunkEmbeddingRepository,
  KnowledgeChunkRepository,
  SqliteVectorIndex,
  type ProjectDatabase,
} from "../../database/src/index.js";
import {
  chunkDocument,
  DOCUMENT_CHUNKER_VERSION,
  DOCUMENT_PARSER_VERSION,
  parseDocument,
} from "@cleodoc/document-ingestion";
import type {
  ChunkDocumentOptions,
  ChunkedDocument,
  ParsedDocument,
} from "@cleodoc/document-ingestion";
import { resolveInsideProject, writeJsonAtomic } from "../../project/src/index.js";
import { MaterialEmbeddingIndexer } from "./material-embedding-indexer.js";
import { MaterialTokenizerPool } from "./material-tokenizers.js";
import type {
  MaterialEmbeddingIndexOptions,
  MaterialEmbeddingIndexResult,
  MaterialEmbeddingModel,
  MaterialIndexDiagnostic,
  MaterialSemanticSearchResult,
} from "./material-types.js";

export interface MaterialIndexRebuildFailure {
  readonly sourceId: string;
  readonly title: string;
  readonly errorCode: string;
  readonly message: string;
}

export interface MaterialIndexRebuildResult {
  readonly indexedCount: number;
  readonly failed: readonly MaterialIndexRebuildFailure[];
}

export class MaterialIndexer {
  private readonly repository: KnowledgeChunkRepository;
  private readonly embeddingRepository: ChunkEmbeddingRepository;
  private readonly tokenizers: MaterialTokenizerPool;
  private readonly embeddings: MaterialEmbeddingIndexer;
  private vectorIndex: SqliteVectorIndex | null = null;

  constructor(
    private readonly projectRoot: string,
    private readonly projectId: string,
    private readonly database: ProjectDatabase,
    private readonly chunking: ChunkDocumentOptions,
    private readonly embeddingModels: Readonly<
      Record<KnowledgeSourceLanguage, MaterialEmbeddingModel>
    >,
    embeddingChunkBatchSize: number,
  ) {
    this.repository = new KnowledgeChunkRepository(database);
    this.embeddingRepository = new ChunkEmbeddingRepository(database);
    this.tokenizers = new MaterialTokenizerPool(embeddingModels);
    this.embeddings = new MaterialEmbeddingIndexer(
      projectId,
      database,
      embeddingModels,
      embeddingChunkBatchSize,
    );
  }

  async markOutdated(sources: readonly KnowledgeSource[]): Promise<void> {
    await this.repository.markOutdated(
      DOCUMENT_PARSER_VERSION,
      DOCUMENT_CHUNKER_VERSION,
      sources.map((source) => ({
        sourceId: source.id,
        chunkingConfigJson: JSON.stringify(this.configFor(source.languages[0]!)),
      })),
    );
  }

  async chunk(
    language: KnowledgeSourceLanguage,
    parsedDocument: ParsedDocument,
    sourceContent: string,
  ): Promise<ChunkedDocument> {
    const tokenizer = await this.tokenizers.get(language);
    return chunkDocument({ parsedDocument, sourceContent }, tokenizer, this.chunking);
  }

  async replace(
    source: KnowledgeSource,
    parsedDocument: ParsedDocument,
    chunkedDocument: ChunkedDocument,
  ): Promise<void> {
    await this.writePreview(source, chunkedDocument);
    await this.repository.replaceForSource({
      sourceId: source.id,
      expectedContentHash: source.contentHash,
      parserVersion: parsedDocument.parserVersion,
      chunkerVersion: chunkedDocument.chunkerVersion,
      chunkingConfigJson: JSON.stringify(chunkedDocument.config),
      chunks: chunkedDocument.chunks,
    });
  }

  search(query: string, limit = 10): KnowledgeSearchResult[] {
    const normalized = query.trim();
    if (normalized === "" || normalized.length > 500) {
      throw new AppError("VALIDATION_ERROR", "检索关键词长度必须为 1–500 个字符。");
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new AppError("VALIDATION_ERROR", "检索结果数量必须为 1–100。");
    }
    return this.repository.search(this.projectId, normalized, limit);
  }

  async searchVector(
    language: KnowledgeSourceLanguage,
    query: Float32Array,
    limit = 10,
  ): Promise<readonly VectorSearchHit[]> {
    this.vectorIndex ??= SqliteVectorIndex.open(this.database);
    return await this.vectorIndex.search(
      query,
      {
        projectId: this.projectId,
        embeddingModelName: this.embeddingModels[language].modelName,
        embeddingModelRevision: this.embeddingModels[language].modelRevision,
      },
      limit,
    );
  }

  async searchSemantic(query: string, limit = 10): Promise<MaterialSemanticSearchResult> {
    const normalized = query.trim();
    if (normalized === "") {
      throw new AppError("VALIDATION_ERROR", "语义检索内容不能为空。");
    }
    const language = detectQueryLanguage(normalized);
    const model = this.embeddingModels[language];
    const embeddingStartedAt = performance.now();
    const embedding = await model.embedQuery(normalized);
    const embeddingDurationMs = performance.now() - embeddingStartedAt;
    const searchStartedAt = performance.now();
    const results = await this.searchVector(language, embedding.vector, limit);
    return {
      language,
      modelId: model.modelId,
      tokenCount: embedding.tokenCount,
      dimensions: embedding.vector.length,
      embeddingDurationMs,
      searchDurationMs: performance.now() - searchStartedAt,
      results,
    };
  }

  listStatus(sources: readonly KnowledgeSource[]): MaterialIndexDiagnostic[] {
    const baseStatuses = new Map(
      this.repository.listStatus().map((status) => [status.sourceId, status] as const),
    );
    const coverage = new Map(
      (["zh", "en"] as const).flatMap((language) => {
        const model = this.embeddingModels[language];
        return this.embeddingRepository
          .listCoverage(this.projectId, language, {
            modelName: model.modelName,
            revision: model.modelRevision,
          })
          .map((item) => [item.sourceId, item] as const);
      }),
    );
    return sources.map((source) => {
      const base = baseStatuses.get(source.id);
      if (base === undefined) {
        throw new AppError("DATABASE_ERROR", "资料索引状态投影缺失。");
      }
      const language = source.languages[0]!;
      const storedEmbeddingCount = coverage.get(source.id)?.embeddedChunks ?? 0;
      const embeddedChunkCount = base.status === "ready" ? storedEmbeddingCount : 0;
      return {
        ...base,
        language,
        embeddingModelId: this.embeddingModels[language].modelId,
        embeddedChunkCount,
        pendingEmbeddingCount: Math.max(0, base.chunkCount - embeddedChunkCount),
      };
    });
  }

  async rebuild(
    sources: readonly KnowledgeSource[],
    readContent: (source: KnowledgeSource) => Promise<string>,
  ): Promise<MaterialIndexRebuildResult> {
    let indexedCount = 0;
    const failed: MaterialIndexRebuildFailure[] = [];
    for (const source of sources) {
      try {
        const content = await readContent(source);
        const parsedDocument = parseDocument({ format: source.format, content });
        const chunkedDocument = await this.chunk(source.languages[0]!, parsedDocument, content);
        await this.replace(source, parsedDocument, chunkedDocument);
        indexedCount += 1;
      } catch (error) {
        const applicationError = asAppError(error);
        await this.repository.markFailed(source.id, applicationError.code);
        failed.push({
          sourceId: source.id,
          title: source.title,
          errorCode: applicationError.code,
          message: applicationError.message,
        });
      }
    }
    return { indexedCount, failed };
  }

  async rebuildFts(): Promise<void> {
    await this.repository.rebuildFts();
  }

  async embed(options: MaterialEmbeddingIndexOptions = {}): Promise<MaterialEmbeddingIndexResult> {
    return await this.embeddings.embed(options);
  }

  async close(): Promise<void> {
    await this.tokenizers.close();
  }

  private configFor(language: KnowledgeSourceLanguage): ChunkedDocument["config"] {
    const model = this.tokenizers.model(language);
    return {
      tokenizerModelId: model.modelId,
      tokenizerRevision: model.modelRevision,
      maxInputTokens: model.maxInputTokens,
      ...this.chunking,
    };
  }

  private async writePreview(
    source: KnowledgeSource,
    chunkedDocument: ChunkedDocument,
  ): Promise<void> {
    const path = await resolveInsideProject(
      this.projectRoot,
      `.cleo/derived/chunks/${source.id}.chunks.json`,
    );
    await writeJsonAtomic(path.absolutePath, {
      schemaVersion: 1,
      sourceId: source.id,
      sourceHash: source.contentHash,
      ...chunkedDocument,
    });
  }
}

export function detectQueryLanguage(query: string): KnowledgeSourceLanguage {
  const hanCharacters = query.match(/\p{Script=Han}/gu)?.length ?? 0;
  const englishWords = query.match(/[A-Za-z]+(?:['’][A-Za-z]+)*/gu)?.length ?? 0;
  return englishWords > hanCharacters ? "en" : "zh";
}
