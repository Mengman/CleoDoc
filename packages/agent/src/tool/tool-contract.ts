import { z } from "zod";

export type ToolExposure = "full" | "catalog";
export type ApprovalMode = "auto" | "ask" | "deny";
export type ApprovalChoice = "reject" | "allow_once" | "allow_until_exit";

export interface ToolIdentity {
  name: string;
  version: number;
}

export interface ToolError {
  code: string;
  message: string;
  recovery?: string;
}

export interface ToolErrorDefinition {
  code: string;
  description: string;
  recovery?: string;
}

export type ToolOutcome<Output> = { ok: true; data: Output } | { ok: false; error: ToolError };

export type ToolResult<Output> = ToolOutcome<Output> & {
  tool: ToolIdentity;
};

export interface ToolExecutionContext {
  readonly projectId: string;
  readonly conversationId: string;
}

export interface Tool<Input, Output> {
  readonly name: string;
  readonly version: number;
  readonly description: string;
  readonly exposure: ToolExposure;
  readonly approval: ApprovalMode;
  readonly errors: readonly ToolErrorDefinition[];
  readonly inputSchema: z.ZodType<Input>;
  readonly outputSchema: z.ZodType<Output>;

  execute(input: Input, context: ToolExecutionContext): Promise<ToolOutcome<Output>>;
  getCompactionMessage(input: Input, outcome: ToolOutcome<Output>): string | null;
}

export type UnknownTool = Tool<unknown, unknown>;

export function asUnknownTool<Input, Output>(tool: Tool<Input, Output>): UnknownTool {
  return tool as unknown as UnknownTool;
}

export interface ToolApprovalRequest {
  toolName: string;
  toolVersion: number;
  input: unknown;
}

export type ToolApprovalHandler = (request: ToolApprovalRequest) => Promise<ApprovalChoice>;

export const emptyInputSchema = z.object({}).strict();
export type EmptyInput = z.infer<typeof emptyInputSchema>;

export function toolSuccess<Output>(data: Output): ToolOutcome<Output> {
  return { ok: true, data };
}

export function toolFailure(code: string, message: string, recovery?: string): ToolOutcome<never> {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(recovery === undefined ? {} : { recovery }),
    },
  };
}

export function wrapToolResult<Output>(
  tool: ToolIdentity,
  outcome: ToolOutcome<Output>,
): ToolResult<Output> {
  return { ...outcome, tool };
}

export function toolIdentity(tool: ToolIdentity): ToolIdentity {
  return { name: tool.name, version: tool.version };
}

export function compactionEvent(
  tool: ToolIdentity,
  outcome: ToolOutcome<unknown>,
  completed: Readonly<Record<string, unknown>> = {},
): string {
  return JSON.stringify(
    outcome.ok
      ? {
          tool: toolIdentity(tool),
          status: "completed",
          ...completed,
        }
      : {
          tool: toolIdentity(tool),
          status: "failed",
          errorCode: outcome.error.code,
        },
  );
}
