import { z } from "zod";

import { AppError } from "../../../contracts/src/index.js";
import type { ProjectInstructionRepository } from "../../../database/src/index.js";
import {
  compactionEvent,
  emptyInputSchema,
  toolSuccess,
  type EmptyInput,
  type Tool,
  type ToolOutcome,
} from "./tool-contract.js";
import { APPROVAL_ERRORS } from "./tool-errors.js";

const updatedAtSchema = z.iso.datetime();

const readProjectInstructionsOutputSchema = z
  .object({
    content: z.string(),
    updatedAt: updatedAtSchema.nullable(),
  })
  .strict();
type ReadProjectInstructionsOutput = z.infer<typeof readProjectInstructionsOutputSchema>;

const appendProjectInstructionsInputSchema = z
  .object({ text: z.string().min(1).max(65_536) })
  .strict();
type AppendProjectInstructionsInput = z.infer<typeof appendProjectInstructionsInputSchema>;

const setProjectInstructionsInputSchema = z.object({ content: z.string().max(65_536) }).strict();
type SetProjectInstructionsInput = z.infer<typeof setProjectInstructionsInputSchema>;

const projectInstructionsMutationOutputSchema = z
  .object({
    updatedAt: updatedAtSchema,
    totalCharacters: z.number().int().nonnegative(),
  })
  .strict();
type ProjectInstructionsMutationOutput = z.infer<typeof projectInstructionsMutationOutputSchema>;

export class ReadProjectInstructionsTool implements Tool<
  EmptyInput,
  ReadProjectInstructionsOutput
> {
  readonly name = "read_project_instructions";
  readonly version = 1;
  readonly description =
    "读取当前项目的完整项目指令。仅在需要检查或准备修改项目指令时使用；普通对话已经由系统上下文提供当前项目指令。";
  readonly exposure = "catalog";
  readonly approval = "auto";
  readonly errors = [] as const;
  readonly inputSchema = emptyInputSchema;
  readonly outputSchema = readProjectInstructionsOutputSchema;

  constructor(private readonly repository: ProjectInstructionRepository) {}

  async execute(): Promise<ToolOutcome<ReadProjectInstructionsOutput>> {
    const current = this.repository.getCurrent();
    return toolSuccess({
      content: current?.content ?? "",
      updatedAt: current?.createdAt ?? null,
    });
  }

  getCompactionMessage(
    _input: EmptyInput,
    outcome: ToolOutcome<ReadProjectInstructionsOutput>,
  ): string {
    void _input;
    return compactionEvent(this, outcome, {
      ...(outcome.ok ? { updatedAt: outcome.data.updatedAt } : {}),
    });
  }
}

export class AppendProjectInstructionsTool implements Tool<
  AppendProjectInstructionsInput,
  ProjectInstructionsMutationOutput
> {
  readonly name = "append_project_instructions";
  readonly version = 1;
  readonly description =
    "在执行时的最新项目指令末尾追加文本。仅在用户要求保留已有指令并增加新规则时使用，执行前需要用户批准。";
  readonly exposure = "catalog";
  readonly approval = "ask";
  readonly errors = APPROVAL_ERRORS;
  readonly inputSchema = appendProjectInstructionsInputSchema;
  readonly outputSchema = projectInstructionsMutationOutputSchema;

  constructor(private readonly repository: ProjectInstructionRepository) {}

  async execute(
    input: AppendProjectInstructionsInput,
  ): Promise<ToolOutcome<ProjectInstructionsMutationOutput>> {
    const revision = await this.appendLatest(input.text);
    return toolSuccess({
      updatedAt: revision.createdAt,
      totalCharacters: revision.content.length,
    });
  }

  getCompactionMessage(
    _input: AppendProjectInstructionsInput,
    outcome: ToolOutcome<ProjectInstructionsMutationOutput>,
  ): string {
    return compactionEvent(this, outcome, {
      operation: "project_instructions_appended",
      ...(outcome.ok
        ? {
            updatedAt: outcome.data.updatedAt,
            totalCharacters: outcome.data.totalCharacters,
          }
        : {}),
    });
  }

  private async appendLatest(text: string) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const current = this.repository.getCurrent();
      try {
        return await this.repository.append(text, current?.revision ?? 0);
      } catch (error) {
        if (attempt === 1 || !(error instanceof AppError) || error.code !== "VALIDATION_ERROR") {
          throw error;
        }
      }
    }
    throw new AppError("TOOL_EXECUTION_FAILED", "项目指令追加失败。");
  }
}

export class SetProjectInstructionsTool implements Tool<
  SetProjectInstructionsInput,
  ProjectInstructionsMutationOutput
> {
  readonly name = "set_project_instructions";
  readonly version = 1;
  readonly description =
    "使用给出的完整内容替换执行时的最新项目指令，空字符串表示清空。仅在用户明确要求整体替换或清空时使用，执行前需要用户批准。";
  readonly exposure = "catalog";
  readonly approval = "ask";
  readonly errors = APPROVAL_ERRORS;
  readonly inputSchema = setProjectInstructionsInputSchema;
  readonly outputSchema = projectInstructionsMutationOutputSchema;

  constructor(private readonly repository: ProjectInstructionRepository) {}

  async execute(
    input: SetProjectInstructionsInput,
  ): Promise<ToolOutcome<ProjectInstructionsMutationOutput>> {
    const revision = await this.setLatest(input.content);
    return toolSuccess({
      updatedAt: revision.createdAt,
      totalCharacters: revision.content.length,
    });
  }

  getCompactionMessage(
    _input: SetProjectInstructionsInput,
    outcome: ToolOutcome<ProjectInstructionsMutationOutput>,
  ): string {
    return compactionEvent(this, outcome, {
      operation: "project_instructions_set",
      ...(outcome.ok
        ? {
            updatedAt: outcome.data.updatedAt,
            totalCharacters: outcome.data.totalCharacters,
          }
        : {}),
    });
  }

  private async setLatest(content: string) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const current = this.repository.getCurrent();
      try {
        return await this.repository.set(content, current?.revision ?? 0);
      } catch (error) {
        if (attempt === 1 || !(error instanceof AppError) || error.code !== "VALIDATION_ERROR") {
          throw error;
        }
      }
    }
    throw new AppError("TOOL_EXECUTION_FAILED", "项目指令整体更新失败。");
  }
}

export function createInstructionDiff(current: string, proposed: string): string {
  if (current === proposed) return "（内容没有变化）";
  return `--- 当前项目指令\n+++ 修改后项目指令\n-${current.replaceAll("\n", "\n-")}\n+${proposed.replaceAll("\n", "\n+")}`;
}
