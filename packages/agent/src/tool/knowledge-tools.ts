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
const materialTitleSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .describe("项目内唯一的资料名称；必须原样使用 list_materials 或搜索结果返回的 title。");

const searchKnowledgeInputSchema = z
  .object({
    query: z.string().trim().min(1).max(500),
    limit: z.number().int().min(1).max(10).optional(),
    title: materialTitleSchema.optional(),
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
          chunkId: z.string(),
          title: materialTitleSchema,
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
          title: materialTitleSchema,
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
    title: materialTitleSchema,
    chunkId: z.string().trim().min(1),
    before: z.number().int().min(0).max(3).optional(),
    after: z.number().int().min(0).max(3).optional(),
  })
  .strict();
type ReadMaterialContextInput = z.infer<typeof readMaterialContextInputSchema>;

const readMaterialContextOutputSchema = z
  .object({
    title: materialTitleSchema,
    targetChunkId: z.string(),
    chunks: z.array(z.object({ chunkId: z.string(), content: z.string() }).strict()),
  })
  .strict();
type ReadMaterialContextOutput = z.infer<typeof readMaterialContextOutputSchema>;

export class SearchKnowledgeTool implements Tool<SearchKnowledgeInput, SearchKnowledgeOutput> {
  readonly name = "search_knowledge";
  readonly version = 2;
  readonly description =
    "在当前项目已建立索引的资料中执行混合检索。可选 title 必须原样使用 list_materials 返回的唯一资料名称；query 必须使用目标资料的语言。";
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
            sourceCount: new Set(outcome.data.results.map((result) => result.title)).size,
            languageWarning: outcome.data.languageWarning,
          }
        : {}),
    });
  }
}

export class ListMaterialsTool implements Tool<ListMaterialsInput, ListMaterialsOutput> {
  readonly name = "list_materials";
  readonly version = 2;
  readonly description =
    "列出当前项目导入资料。title 是供 search_knowledge 使用的项目内唯一资料名称；不读取资料正文。";
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
  readonly version = 2;
  readonly description =
    "根据 search_knowledge 同一结果中的 title 和 chunkId 读取目标 Chunk 及有限相邻 Chunk，两者都必须原样传递。";
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
