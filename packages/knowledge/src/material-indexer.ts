import type {
  KnowledgeSearchResult,
  KnowledgeSource,
  KnowledgeSourceLanguage,
  KnowledgeSourceIndexStatus,
  VectorSearchHit,
} from "../../contracts/src/index.js";
import { AppError, asAppError } from "../../contracts/src/index.js";
import {
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
  private readonly tokenizers: MaterialTokenizerPool;
  private readonly embeddings: MaterialEmbeddingIndexer;
  private vectorIndex: SqliteVectorIndex | null = null;

  constructor(
    private readonly projectRoot: string,
    private readonly projectId: string,
    private readonly database: ProjectDatabase,
    private readonly chunking: ChunkDocumentOptions,
    embeddingModels: Readonly<Record<KnowledgeSourceLanguage, MaterialEmbeddingModel>>,
    embeddingChunkBatchSize: number,
  ) {
    this.repository = new KnowledgeChunkRepository(database);
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
        embeddingModelId: this.tokenizers.model(language).modelId,
      },
      limit,
    );
  }

  listStatus(): KnowledgeSourceIndexStatus[] {
    return this.repository.listStatus();
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
