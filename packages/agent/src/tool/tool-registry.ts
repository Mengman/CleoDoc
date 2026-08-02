import { z } from "zod";

import type { ModelToolDefinition } from "../../../contracts/src/index.js";
import { AppError } from "../../../contracts/src/index.js";
import type { Tool, ToolIdentity } from "./tool-contract.js";

export type UnknownTool = Tool<unknown, unknown>;

export class ToolRegistry {
  private readonly tools = new Map<string, UnknownTool>();
  private readonly loaded = new Set<string>();

  constructor(loadedTools: Iterable<ToolIdentity> = []) {
    for (const tool of loadedTools) this.loaded.add(toolKey(tool));
  }

  register<Input, Output>(tool: Tool<Input, Output>): void {
    if (this.tools.has(tool.name)) {
      throw new AppError("VALIDATION_ERROR", `Tool 名称重复：${tool.name}`);
    }
    this.tools.set(tool.name, tool as unknown as UnknownTool);
  }

  get(name: string): UnknownTool | undefined {
    return this.tools.get(name);
  }

  getCallable(name: string): UnknownTool | undefined {
    const tool = this.tools.get(name);
    return tool !== undefined && (tool.exposure === "full" || this.loaded.has(toolKey(tool)))
      ? tool
      : undefined;
  }

  getProviderDefinitions(): ModelToolDefinition[] {
    return [...this.tools.values()]
      .filter((tool) => tool.exposure === "full" || this.loaded.has(toolKey(tool)))
      .map((tool) => ({
        name: tool.name,
        version: tool.version,
        description: `[Tool v${tool.version}] ${tool.description}`,
        inputSchema: toJsonSchema(tool.inputSchema),
      }));
  }

  getDisclosurePrompt(): string {
    const summaries = [...this.tools.values()]
      .filter((tool) => tool.exposure === "summary" && !this.loaded.has(toolKey(tool)))
      .sort(compareTools)
      .map((tool) => `- ${tool.name} v${tool.version}: ${tool.description}`);
    const hiddenCount = [...this.tools.values()].filter(
      (tool) => tool.exposure === "hidden" && !this.loaded.has(toolKey(tool)),
    ).length;
    if (summaries.length === 0 && hiddenCount === 0) return "";
    return [
      "以下 Tool 当前只有摘要，调用前先使用 get_tool 加载完整定义：",
      ...(summaries.length === 0 ? ["- 无"] : summaries),
      ...(hiddenCount === 0
        ? []
        : [`另有 ${hiddenCount} 个未展示 Tool，可使用 list_tools 分页查看。`]),
    ].join("\n");
  }

  listAll(): UnknownTool[] {
    return [...this.tools.values()].sort(compareTools);
  }

  load(name: string): UnknownTool | undefined {
    const tool = this.tools.get(name);
    if (tool !== undefined) this.loaded.add(toolKey(tool));
    return tool;
  }

  publicDefinition(tool: UnknownTool) {
    return {
      name: tool.name,
      version: tool.version,
      description: tool.description,
      approval: tool.approval,
      inputSchema: toJsonSchema(tool.inputSchema),
      outputSchema: toJsonSchema(tool.outputSchema),
      errors: tool.errors.map((error) => ({ ...error })),
    };
  }
}

function compareTools(left: UnknownTool, right: UnknownTool): number {
  return left.name.localeCompare(right.name, "en");
}

function toolKey(tool: ToolIdentity): string {
  return `${tool.name}@${tool.version}`;
}

function toJsonSchema(schema: z.ZodType): Readonly<Record<string, unknown>> {
  return z.toJSONSchema(schema) as Readonly<Record<string, unknown>>;
}
