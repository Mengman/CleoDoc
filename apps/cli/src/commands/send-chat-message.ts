import type {
  ChatService,
  LlmDebugHandler,
  ToolApprovalHandler,
} from "../../../../packages/agent/src/index.js";
import type { ChatTurnResult } from "../../../../packages/contracts/src/index.js";
import type { CliCommandContext } from "./command-context.js";
import { installInterruptHandler } from "./command-utils.js";

export async function generateOnce(
  context: CliCommandContext,
  chat: ChatService,
  inputValue: {
    projectId: string;
    prompt: string;
    conversationId?: string;
    approveToolCall?: ToolApprovalHandler;
    onDebugEvent?: LlmDebugHandler;
  },
): Promise<ChatTurnResult> {
  // Send one cancellable chat turn and stream its reasoning and answer to the terminal.
  // 1. Install an interrupt handler for the request AbortController.
  // 2. Render reasoning and answer deltas with explicit phase transitions.
  // 3. Print the persisted conversation identity and always remove the handler.
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
    context.output.write(`对话 ID：${result.conversationId}\n`);
    return result;
  } finally {
    removeHandler();
  }
}
