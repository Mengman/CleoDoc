import { z } from "zod";

import type { ModelToolDefinition } from "../../../contracts/src/index.js";
import { AppError } from "../../../contracts/src/index.js";
import type {
  ProjectInstructionRepository,
  SessionRepository,
} from "../../../database/src/index.js";
import type { DocumentService } from "../../../project/src/index.js";
import type { KnowledgeToolService } from "../../../knowledge/src/index.js";
import {
  ListProjectDocumentsTool,
  ReadProjectDocumentTool,
  WriteProjectDocumentTool,
} from "./document-tools.js";
import {
  AppendProjectInstructionsTool,
  ReadProjectInstructionsTool,
  SetProjectInstructionsTool,
} from "./project-instructions-tools.js";
import {
  ReadConversationMessageTool,
  SearchConversationHistoryTool,
} from "./conversation-history-tools.js";
import { createKnowledgeTools } from "./knowledge-tools.js";
import {
  asUnknownTool,
  toolFailure,
  toolSuccess,
  type Tool,
  type ToolErrorDefinition,
  type ToolExecutionContext,
  type ToolIdentity,
  type ToolOutcome,
  type UnknownTool,
} from "./tool-contract.js";

const catalogInputSchema = z
  .object({
    action: z.enum(["list", "get"]),
    page: z.number().int().positive().optional(),
    pageSize: z.number().int().min(1).max(20).optional(),
    name: z.string().trim().min(1).optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.action === "get" && input.name === undefined) {
      context.addIssue({
        code: "custom",
        path: ["name"],
        message: "get 操作必须提供 Tool 名称。",
      });
    }
  });
type ProjectToolCatalogInput = z.infer<typeof catalogInputSchema>;

const toolSummarySchema = z
  .object({
    name: z.string(),
    version: z.number().int().positive(),
    description: z.string(),
  })
  .strict();
const jsonSchemaObject = z.record(z.string(), z.unknown());
const publicDefinitionSchema = toolSummarySchema
  .extend({
    approval: z.enum(["auto", "ask", "deny"]),
    inputSchema: jsonSchemaObject,
    outputSchema: jsonSchemaObject,
    errors: z.array(
      z
        .object({
          code: z.string(),
          description: z.string(),
          recovery: z.string().optional(),
        })
        .strict(),
    ),
  })
  .strict();
const catalogOutputSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("list"),
      tools: z.array(toolSummarySchema),
      page: z.number().int().positive(),
      pageSize: z.number().int().positive(),
      totalPages: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      action: z.literal("get"),
      tool: publicDefinitionSchema,
      callableNextRound: z.literal(true),
    })
    .strict(),
]);
type ProjectToolCatalogOutput = z.infer<typeof catalogOutputSchema>;

export interface ProjectToolCatalogDependencies {
  documents: DocumentService;
  projectInstructions?: ProjectInstructionRepository;
  history?: SessionRepository;
  knowledge?: KnowledgeToolService;
}

export interface ProjectToolInfo {
  definitions: ModelToolDefinition[];
}

export class ProjectToolCatalog implements Tool<ProjectToolCatalogInput, ProjectToolCatalogOutput> {
  readonly name = "project_tool_catalog";
  readonly version = 1;
  readonly description =
    "发现当前项目可用的 Tool。使用 list 分页查看全部 Tool；使用 get 按名称取得完整定义并使该版本从下一轮起可调用。";
  readonly exposure = "full";
  readonly approval = "auto";
  readonly errors = [
    {
      code: "TOOL_NOT_FOUND",
      description: "Tool 不存在或当前项目不可用。",
      recovery: "使用 project_tool_catalog 的 list 操作查看当前可用 Tool。",
    },
  ] as const satisfies readonly ToolErrorDefinition[];
  readonly inputSchema = catalogInputSchema;
  readonly outputSchema = catalogOutputSchema;

  private readonly tools = new Map<string, UnknownTool>();

  constructor(tools: readonly UnknownTool[]) {
    for (const tool of tools) {
      if (tool.name === this.name || this.tools.has(tool.name)) {
        throw new AppError("VALIDATION_ERROR", `Tool 名称重复：${tool.name}`);
      }
      this.tools.set(tool.name, tool);
    }
  }

  static create(dependencies: ProjectToolCatalogDependencies): ProjectToolCatalog {
    const tools: UnknownTool[] = [
      asUnknownTool(new ListProjectDocumentsTool(dependencies.documents)),
      asUnknownTool(new ReadProjectDocumentTool(dependencies.documents)),
      asUnknownTool(new WriteProjectDocumentTool(dependencies.documents)),
    ];
    if (dependencies.projectInstructions !== undefined) {
      tools.push(
        asUnknownTool(new ReadProjectInstructionsTool(dependencies.projectInstructions)),
        asUnknownTool(new AppendProjectInstructionsTool(dependencies.projectInstructions)),
        asUnknownTool(new SetProjectInstructionsTool(dependencies.projectInstructions)),
      );
    }
    if (dependencies.history !== undefined) {
      tools.push(
        asUnknownTool(new SearchConversationHistoryTool(dependencies.history)),
        asUnknownTool(new ReadConversationMessageTool(dependencies.history)),
      );
    }
    if (dependencies.knowledge !== undefined) {
      tools.push(...createKnowledgeTools(dependencies.knowledge));
    }
    return new ProjectToolCatalog(tools);
  }

  getTool(name: string): UnknownTool | undefined {
    return this.tools.get(name);
  }

  getToolOrSelf(name: string): UnknownTool | undefined {
    return name === this.name ? asUnknownTool(this) : this.getTool(name);
  }

  getToolInfo(loadedToolVersions: ReadonlySet<string>): ProjectToolInfo {
    const callable = this.listAll().filter(
      (tool) => tool.exposure === "full" || loadedToolVersions.has(toolKey(tool)),
    );
    return {
      definitions: callable.map((tool) => this.providerDefinition(tool)),
    };
  }

  async execute(
    input: ProjectToolCatalogInput,
    _context: ToolExecutionContext,
  ): Promise<ToolOutcome<ProjectToolCatalogOutput>> {
    void _context;
    if (input.action === "list") {
      const tools = this.listAll();
      const page = input.page ?? 1;
      const pageSize = input.pageSize ?? 10;
      const totalPages = tools.length === 0 ? 0 : Math.ceil(tools.length / pageSize);
      const start = (page - 1) * pageSize;
      return toolSuccess({
        action: "list",
        tools: tools.slice(start, start + pageSize).map(toSummary),
        page,
        pageSize,
        totalPages,
      });
    }

    if (input.name === undefined) {
      return toolFailure("INVALID_TOOL_INPUT", "get 操作缺少 Tool 名称。");
    }
    const tool = this.getToolOrSelf(input.name);
    if (tool === undefined) {
      return toolFailure(
        "TOOL_NOT_FOUND",
        "找不到当前项目可用的指定 Tool。",
        "使用 project_tool_catalog 的 list 操作查看当前可用 Tool。",
      );
    }
    return toolSuccess({
      action: "get",
      tool: this.publicDefinition(tool),
      callableNextRound: true,
    });
  }

  getCompactionMessage(): null {
    return null;
  }

  private listAll(): UnknownTool[] {
    return [asUnknownTool(this), ...this.tools.values()].sort(compareTools);
  }

  private providerDefinition(tool: UnknownTool): ModelToolDefinition {
    return {
      name: tool.name,
      version: tool.version,
      description: `[Tool v${tool.version}] ${tool.description}`,
      inputSchema: toJsonSchema(tool.inputSchema),
    };
  }

  private publicDefinition(tool: UnknownTool) {
    return {
      ...toSummary(tool),
      approval: tool.approval,
      inputSchema: toJsonSchema(tool.inputSchema),
      outputSchema: toJsonSchema(tool.outputSchema),
      errors: tool.errors.map((error) => ({ ...error })),
    };
  }
}

export function toolKey(tool: ToolIdentity): string {
  return `${tool.name}@${tool.version}`;
}

function compareTools(left: UnknownTool, right: UnknownTool): number {
  return left.name.localeCompare(right.name, "en");
}

function toSummary(tool: UnknownTool) {
  return { name: tool.name, version: tool.version, description: tool.description };
}

function toJsonSchema(schema: z.ZodType): Readonly<Record<string, unknown>> {
  return z.toJSONSchema(schema) as Readonly<Record<string, unknown>>;
}
