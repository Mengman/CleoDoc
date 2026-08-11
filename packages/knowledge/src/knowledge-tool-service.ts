import type {
  KnowledgeIndexStatus,
  KnowledgeSource,
  KnowledgeSourceLanguage,
} from "../../contracts/src/index.js";
import { AppError } from "../../contracts/src/index.js";
import { MaterialService } from "./material-service.js";
import type { MaterialServiceOptions } from "./material-types.js";

export interface SearchKnowledgeRequest {
  readonly projectId: string;
  readonly query: string;
  readonly limit?: number;
  readonly title?: string;
}

export interface SearchKnowledgeResult {
  readonly queryLanguage: KnowledgeSourceLanguage;
  readonly sourceLanguages: KnowledgeSourceLanguage[];
  readonly languageWarning: string | null;
  readonly results: {
    chunkId: string;
    title: string;
    content: string;
  }[];
}

export interface ListKnowledgeMaterialsRequest {
  readonly projectId: string;
  readonly page?: number;
  readonly pageSize?: number;
}

export interface ListKnowledgeMaterialsResult {
  readonly materials: {
    title: string;
    format: KnowledgeSource["format"];
    languages: KnowledgeSourceLanguage[];
    indexStatus: KnowledgeIndexStatus;
  }[];
  readonly page: number;
  readonly totalPages: number;
}

export interface ReadMaterialContextRequest {
  readonly projectId: string;
  readonly title: string;
  readonly chunkId: string;
  readonly before?: number;
  readonly after?: number;
}

export interface ReadMaterialContextResult {
  readonly title: string;
  readonly targetChunkId: string;
  readonly chunks: { chunkId: string; content: string }[];
}

export class KnowledgeToolService {
  private constructor(private readonly materials: MaterialService) {}

  static async open(
    projectRoot: string,
    options: MaterialServiceOptions,
  ): Promise<KnowledgeToolService> {
    return new KnowledgeToolService(await MaterialService.open(projectRoot, options));
  }

  async searchKnowledge(input: SearchKnowledgeRequest): Promise<SearchKnowledgeResult> {
    this.assertProject(input.projectId);
    const { sources, statusBySource } = await this.readSourceSnapshot();
    const selected = selectSources(sources, statusBySource, input.title);
    const sourceLanguages = orderedLanguages(selected);
    const sourceId =
      selected.length === 1 && input.title !== undefined ? selected[0]!.id : undefined;
    const result = await this.materials.searchHybrid(input.query, {
      limit: input.limit ?? 5,
      ...(sourceId === undefined ? {} : { filter: { sourceId } }),
    });
    return {
      queryLanguage: result.language,
      sourceLanguages,
      languageWarning: languageWarning(result.language, sourceLanguages),
      results: result.retrievalContext.items.map(({ chunk }) => ({
        chunkId: chunk.chunkId,
        title: chunk.sourceTitle,
        content: chunk.content,
      })),
    };
  }

  async listMaterials(input: ListKnowledgeMaterialsRequest): Promise<ListKnowledgeMaterialsResult> {
    this.assertProject(input.projectId);
    const page = input.page ?? 1;
    const pageSize = input.pageSize ?? 10;
    const { sources, statusBySource } = await this.readSourceSnapshot();
    const totalPages = sources.length === 0 ? 0 : Math.ceil(sources.length / pageSize);
    const start = (page - 1) * pageSize;
    return {
      materials: sources.slice(start, start + pageSize).map((source) => ({
        title: source.title,
        format: source.format,
        languages: source.languages,
        indexStatus: statusBySource.get(source.id) ?? "pending",
      })),
      page,
      totalPages,
    };
  }

  async readMaterialContext(input: ReadMaterialContextRequest): Promise<ReadMaterialContextResult> {
    this.assertProject(input.projectId);
    const { sources, statusBySource } = await this.readSourceSnapshot();
    const [source] = selectSources(sources, statusBySource, input.title);
    const result = this.materials.readChunkContext(
      source!.id,
      input.chunkId,
      input.before ?? 1,
      input.after ?? 1,
    );
    return {
      title: result.sourceTitle,
      targetChunkId: result.targetChunkId,
      chunks: result.chunks.map((chunk) => ({ ...chunk })),
    };
  }

  async close(): Promise<void> {
    await this.materials.close();
  }

  private assertProject(projectId: string): void {
    if (projectId !== this.materials.projectId) {
      throw new AppError("MATERIAL_NOT_FOUND", "当前项目中找不到指定资料。");
    }
  }

  private async readSourceSnapshot(): Promise<{
    sources: KnowledgeSource[];
    statusBySource: Map<string, KnowledgeIndexStatus>;
  }> {
    const sources = await this.materials.list();
    const statuses = await this.materials.getIndexStatus();
    return {
      sources,
      statusBySource: new Map(statuses.map((status) => [status.sourceId, status.status])),
    };
  }
}

function selectSources(
  sources: readonly KnowledgeSource[],
  statusBySource: ReadonlyMap<string, KnowledgeIndexStatus>,
  title: string | undefined,
): KnowledgeSource[] {
  if (title !== undefined) {
    const normalizedTitle = title.trim();
    const source = sources.find((candidate) => candidate.title === normalizedTitle);
    if (source === undefined) {
      throw new AppError("MATERIAL_NOT_FOUND", "当前项目中找不到指定资料。");
    }
    if (statusBySource.get(source.id) !== "ready") {
      throw new AppError("MATERIAL_NOT_INDEXED", "指定资料尚未完成有效索引。");
    }
    return [source];
  }
  return sources.filter((source) => statusBySource.get(source.id) === "ready");
}

function orderedLanguages(sources: readonly KnowledgeSource[]): KnowledgeSourceLanguage[] {
  const found = new Set(sources.flatMap((source) => source.languages));
  return (["zh", "en"] as const).filter((language) => found.has(language));
}

function languageWarning(
  queryLanguage: KnowledgeSourceLanguage,
  sourceLanguages: readonly KnowledgeSourceLanguage[],
): string | null {
  if (sourceLanguages.length === 0 || sourceLanguages.includes(queryLanguage)) return null;
  const target = sourceLanguages[0] === "en" ? "英文" : "中文";
  const query = sourceLanguages[0] === "en" ? "英文 query" : "中文 query";
  return `资料是${target}的，请使用${query} 重新搜索。`;
}
