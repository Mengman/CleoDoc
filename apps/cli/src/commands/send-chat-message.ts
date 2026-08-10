import type {
  ChatService,
  LlmDebugHandler,
  ToolApprovalHandler,
} from "../../../../packages/agent/src/index.js";
import type {
  ChatGenerationResult,
  ContextBudgetPolicy,
  ModelProvider,
} from "../../../../packages/contracts/src/index.js";
import type { CliCommandContext } from "./command-context.js";
import { installInterruptHandler } from "./command-utils.js";

export async function generateOnce(
  context: CliCommandContext,
  chat: ChatService,
  inputValue: {
    projectId: string;
    provider: ModelProvider;
    model: string;
    prompt: string;
    conversationId?: string;
    approveToolCall?: ToolApprovalHandler;
    contextBudgetPolicy: ContextBudgetPolicy;
    onDebugEvent?: LlmDebugHandler;
  },
): Promise<ChatGenerationResult> {
  const controller = new AbortController();
  const removeHandler = installInterruptHandler(context, controller);
  let displayPhase: "idle" | "reasoning" | "answer" = "idle";
  try {
    const result = await chat.send({
      ...inputValue,
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === "reasoning-delta") {
          if (displayPhase !== "reasoning") {
            context.output.write(`${displayPhase === "idle" ? "\n" : "\n\n"}思考中：\n`);
            displayPhase = "reasoning";
          }
          context.output.write(event.text);
        } else if (event.type === "text-delta") {
          if (displayPhase === "reasoning") {
            context.output.write("\n\n回答：\n");
          }
          displayPhase = "answer";
          context.output.write(event.text);
        }
      },
    });
    context.output.write("\n");
    context.output.write(`对话 ID：${result.conversationId}\n生成 ID：${result.generationId}\n`);
    return result;
  } finally {
    removeHandler();
  }
}
