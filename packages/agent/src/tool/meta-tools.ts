import { z } from "zod";

import {
  toolFailure,
  toolSuccess,
  type Tool,
  type ToolErrorDefinition,
  type ToolOutcome,
} from "./tool-contract.js";
import type { ToolRegistry } from "./tool-registry.js";

const listToolsInputSchema = z
  .object({
    page: z.number().int().positive().default(1),
    pageSize: z.number().int().min(1).max(20).default(10),
  })
  .strict();
type ListToolsInput = z.infer<typeof listToolsInputSchema>;

const listToolsOutputSchema = z
  .object({
    tools: z.array(
      z
        .object({
          name: z.string(),
          version: z.number().int().positive(),
          description: z.string(),
        })
        .strict(),
    ),
    page: z.number().int().positive(),
    pageSize: z.number().int().positive(),
    totalPages: z.number().int().nonnegative(),
  })
  .strict();
type ListToolsOutput = z.infer<typeof listToolsOutputSchema>;

const getToolInputSchema = z.object({ name: z.string().trim().min(1) }).strict();
type GetToolInput = z.infer<typeof getToolInputSchema>;

const jsonSchemaObject = z.record(z.string(), z.unknown());
const getToolOutputSchema = z
  .object({
    tool: z
      .object({
        name: z.string(),
        version: z.number().int().positive(),
        description: z.string(),
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
      .strict(),
    callableNextRound: z.literal(true),
  })
  .strict();
type GetToolOutput = z.infer<typeof getToolOutputSchema>;

export class ListToolsTool implements Tool<ListToolsInput, ListToolsOutput> {
  readonly name = "list_tools";
  readonly version = 1;
  readonly description =
    "分页列出当前 Agent 回合中已授权的全部 Tool，返回名称、版本和描述；需要查看完整定义时再使用 get_tool。";
  readonly exposure = "full";
  readonly approval = "auto";
  readonly errors = [] as const;
  readonly inputSchema = listToolsInputSchema;
  readonly outputSchema = listToolsOutputSchema;

  constructor(private readonly registry: ToolRegistry) {}

  async execute(input: ListToolsInput): Promise<ToolOutcome<ListToolsOutput>> {
    const tools = this.registry.listAll();
    const totalPages = tools.length === 0 ? 0 : Math.ceil(tools.length / input.pageSize);
    const start = (input.page - 1) * input.pageSize;
    return toolSuccess({
      tools: tools.slice(start, start + input.pageSize).map((tool) => ({
        name: tool.name,
        version: tool.version,
        description: tool.description,
      })),
      page: input.page,
      pageSize: input.pageSize,
      totalPages,
    });
  }

  getCompactionMessage(): null {
    return null;
  }
}

export class GetToolTool implements Tool<GetToolInput, GetToolOutput> {
  readonly name = "get_tool";
  readonly version = 1;
  readonly description =
    "根据名称查询当前 Conversation 允许使用的 Tool 完整定义，并将该版本加入后续模型请求的可调用 Tool 列表。";
  readonly exposure = "full";
  readonly approval = "auto";
  readonly errors = [
    {
      code: "TOOL_NOT_FOUND",
      description: "Tool 不存在或当前任务不可用。",
      recovery: "调用 list_tools 查看当前可用 Tool。",
    },
  ] as const satisfies readonly ToolErrorDefinition[];
  readonly inputSchema = getToolInputSchema;
  readonly outputSchema = getToolOutputSchema;

  constructor(private readonly registry: ToolRegistry) {}

  async execute(input: GetToolInput): Promise<ToolOutcome<GetToolOutput>> {
    const tool = this.registry.load(input.name);
    if (tool === undefined) {
      return toolFailure(
        "TOOL_NOT_FOUND",
        "找不到当前任务可用的指定 Tool。",
        "调用 list_tools 查看当前可用 Tool。",
      );
    }
    return toolSuccess({
      tool: this.registry.publicDefinition(tool),
      callableNextRound: true,
    });
  }

  getCompactionMessage(): null {
    return null;
  }
}
