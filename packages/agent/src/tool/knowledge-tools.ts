import { z } from "zod";

import type { KnowledgeToolService } from "../../../knowledge/src/index.js";
import {
  asUnknownTool,
  compactionEvent,
  toolSuccess,
  type Tool,
  type ToolExecutionContext,
  type ToolOutcome,
  type UnknownTool,
} from "./tool-contract.js";
import { KNOWLEDGE_ERRORS } from "./tool-errors.js";

const languageSchema = z.enum(["zh", "en"]);
const materialFormatSchema = z.enum(["text", "markdown"]);
const indexStatusSchema = z.enum(["pending", "ready", "stale", "failed"]);

const searchKnowledgeInputSchema = z
  .object({
    query: z.string().trim().min(1).max(500),
    limit: z.number().int().min(1).max(10).optional(),
    source: z.string().trim().min(1).optional(),
  })
  .strict();
type SearchKnowledgeInput = z.infer<typeof searchKnowledgeInputSchema>;

const searchKnowledgeOutputSchema = z
  .object({
    queryLanguage: languageSchema,
    sourceLanguages: z.array(languageSchema),
    languageWarning: z.string().nullable(),
    results: z.array(
      z
        .object({
          source: z.string(),
          chunkId: z.string(),
          title: z.string(),
          content: z.string(),
        })
        .strict(),
    ),
  })
  .strict();
type SearchKnowledgeOutput = z.infer<typeof searchKnowledgeOutputSchema>;

const listMaterialsInputSchema = z
  .object({
    page: z.number().int().positive().optional(),
    pageSize: z.number().int().min(1).max(20).optional(),
  })
  .strict();
type ListMaterialsInput = z.infer<typeof listMaterialsInputSchema>;

const listMaterialsOutputSchema = z
  .object({
    materials: z.array(
      z
        .object({
          source: z.string(),
          title: z.string(),
          format: materialFormatSchema,
          languages: z.array(languageSchema),
          indexStatus: indexStatusSchema,
        })
        .strict(),
    ),
    page: z.number().int().positive(),
    totalPages: z.number().int().nonnegative(),
  })
  .strict();
type ListMaterialsOutput = z.infer<typeof listMaterialsOutputSchema>;

const readMaterialContextInputSchema = z
  .object({
    source: z.string().trim().min(1),
    chunkId: z.string().trim().min(1),
    before: z.number().int().min(0).max(3).optional(),
    after: z.number().int().min(0).max(3).optional(),
  })
  .strict();
type ReadMaterialContextInput = z.infer<typeof readMaterialContextInputSchema>;

const readMaterialContextOutputSchema = z
  .object({
    source: z.string(),
    title: z.string(),
    targetChunkId: z.string(),
    chunks: z.array(z.object({ chunkId: z.string(), content: z.string() }).strict()),
  })
  .strict();
type ReadMaterialContextOutput = z.infer<typeof readMaterialContextOutputSchema>;

export class SearchKnowledgeTool implements Tool<SearchKnowledgeInput, SearchKnowledgeOutput> {
  readonly name = "search_knowledge";
  readonly version = 1;
  readonly description =
    "在当前项目已建立索引的资料中执行混合检索。query 必须使用目标资料的语言；不清楚资料语言时先调用 list_materials。";
  readonly exposure = "full";
  readonly approval = "auto";
  readonly errors = KNOWLEDGE_ERRORS;
  readonly inputSchema = searchKnowledgeInputSchema;
  readonly outputSchema = searchKnowledgeOutputSchema;

  constructor(private readonly service: KnowledgeToolService) {}

  async execute(
    input: SearchKnowledgeInput,
    context: ToolExecutionContext,
  ): Promise<ToolOutcome<SearchKnowledgeOutput>> {
    return toolSuccess(
      await this.service.searchKnowledge({ projectId: context.projectId, ...input }),
    );
  }

  getCompactionMessage(
    _input: SearchKnowledgeInput,
    outcome: ToolOutcome<SearchKnowledgeOutput>,
  ): string {
    return compactionEvent(this, outcome, {
      ...(outcome.ok
        ? {
            queryLanguage: outcome.data.queryLanguage,
            resultCount: outcome.data.results.length,
            sourceCount: new Set(outcome.data.results.map((result) => result.source)).size,
            languageWarning: outcome.data.languageWarning,
          }
        : {}),
    });
  }
}

export class ListMaterialsTool implements Tool<ListMaterialsInput, ListMaterialsOutput> {
  readonly name = "list_materials";
  readonly version = 1;
  readonly description =
    "列出当前项目导入资料的标题、格式、语言、公开 Source 标识和索引状态；不读取资料正文。";
  readonly exposure = "full";
  readonly approval = "auto";
  readonly errors = [] as const;
  readonly inputSchema = listMaterialsInputSchema;
  readonly outputSchema = listMaterialsOutputSchema;

  constructor(private readonly service: KnowledgeToolService) {}

  async execute(
    input: ListMaterialsInput,
    context: ToolExecutionContext,
  ): Promise<ToolOutcome<ListMaterialsOutput>> {
    return toolSuccess(
      await this.service.listMaterials({ projectId: context.projectId, ...input }),
    );
  }

  getCompactionMessage(
    _input: ListMaterialsInput,
    outcome: ToolOutcome<ListMaterialsOutput>,
  ): string {
    return compactionEvent(this, outcome, {
      ...(outcome.ok
        ? {
            materialCount: outcome.data.materials.length,
            page: outcome.data.page,
            totalPages: outcome.data.totalPages,
          }
        : {}),
    });
  }
}

export class ReadMaterialContextTool implements Tool<
  ReadMaterialContextInput,
  ReadMaterialContextOutput
> {
  readonly name = "read_material_context";
  readonly version = 1;
  readonly description =
    "根据 search_knowledge 返回的 source 和 chunkId，读取目标 Chunk 及有限相邻 Chunk；只在搜索结果缺少必要前后文时调用。";
  readonly exposure = "catalog";
  readonly approval = "auto";
  readonly errors = KNOWLEDGE_ERRORS;
  readonly inputSchema = readMaterialContextInputSchema;
  readonly outputSchema = readMaterialContextOutputSchema;

  constructor(private readonly service: KnowledgeToolService) {}

  async execute(
    input: ReadMaterialContextInput,
    context: ToolExecutionContext,
  ): Promise<ToolOutcome<ReadMaterialContextOutput>> {
    return toolSuccess(
      await this.service.readMaterialContext({ projectId: context.projectId, ...input }),
    );
  }

  getCompactionMessage(
    _input: ReadMaterialContextInput,
    outcome: ToolOutcome<ReadMaterialContextOutput>,
  ): string {
    return compactionEvent(this, outcome, {
      ...(outcome.ok ? { chunkCount: outcome.data.chunks.length } : {}),
    });
  }
}

export function createKnowledgeTools(service: KnowledgeToolService): UnknownTool[] {
  return [
    asUnknownTool(new SearchKnowledgeTool(service)),
    asUnknownTool(new ListMaterialsTool(service)),
    asUnknownTool(new ReadMaterialContextTool(service)),
  ];
}
