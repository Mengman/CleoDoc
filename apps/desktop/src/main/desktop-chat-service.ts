import { createContextBudgetPolicy } from "../../../../packages/agent/src/index.js";
import { getSoftwareConfig } from "../../../../packages/config/src/index.js";
import {
  AppError,
  type ModelEvent,
  type ModelMessageSender,
} from "../../../../packages/contracts/src/index.js";
import {
  desktopChatMessageEventSchema,
  type DesktopChatMessageEvent,
  type SendDesktopChatMessageInput,
} from "../shared/desktop-api.js";
import type { DesktopProjectRuntime } from "./desktop-project-runtime.js";

export interface DesktopChatResult {
  readonly conversation: { readonly id: string; readonly title: string | null };
  readonly messages: readonly {
    readonly id: string;
    readonly role: "user" | "assistant";
    readonly content: string;
    readonly reasoningContent?: string;
    readonly sequence: number;
    readonly createdAt: string;
  }[];
}

export function createDesktopChatServiceOptions() {
  // Build the project chat runtime from the validated software configuration.
  const config = getSoftwareConfig();
  const providerId = config.llm.selectedProvider ?? "openai-compatible";
  const modelName = config.llm.selectedModel;
  const model =
    modelName === null ? undefined : config.llm.providers[providerId]?.models[modelName];
  return {
    maxToolRounds: config.agent.maxToolRounds,
    ...(model === undefined
      ? {}
      : { defaultContextBudgetPolicy: createContextBudgetPolicy(model, config.context) }),
    compaction: config.agent.compaction,
  };
}

export class DesktopChatService {
  constructor(
    private readonly projects: DesktopProjectRuntime,
    private readonly providerService: ModelMessageSender,
  ) {}

  send(
    input: SendDesktopChatMessageInput,
    emitEvent: (event: DesktopChatMessageEvent) => void,
  ): Promise<DesktopChatResult> {
    // Continue one existing conversation through the active project and desktop stream contract.
    // 1. Resolve the immutable Provider and model identity from the project-owned conversation.
    // 2. Send through ChatService and translate model deltas into renderer-safe desktop events.
    // 3. Return the current persisted conversation projection after the generation settles.
    return this.projects.runChatTask(async ({ projectId, signal, chat, conversations }) => {
      const conversation = conversations.getConversation(input.conversationId);
      const contextBudgetPolicy = resolveConversationContextBudget(
        conversation.providerId,
        conversation.model,
      );
      const stream = new DesktopChatEventStream(input, emitEvent);
      const result = await chat.send({
        conversationId: conversation.id,
        projectId,
        prompt: input.prompt,
        provider: this.providerService,
        model: conversation.model,
        contextBudgetPolicy,
        signal,
        onEvent: (event) => stream.accept(event),
      });
      stream.completeReasoning();
      const history = conversations.getRecentHistory(result.conversationId, 20);
      const visibleMessages = history.messages.filter(
        (message): message is typeof message & { role: "user" | "assistant" } =>
          message.role === "user" || message.role === "assistant",
      );
      return {
        conversation: { id: history.conversation.id, title: history.conversation.title },
        messages: visibleMessages.map((message) => ({
          id: message.id,
          role: message.role,
          content: message.content,
          ...(message.reasoningContent === undefined
            ? {}
            : { reasoningContent: message.reasoningContent }),
          sequence: message.sequence,
          createdAt: message.createdAt,
        })),
      };
    });
  }
}

class DesktopChatEventStream {
  private reasoningStarted = false;
  private reasoningCompleted = false;
  private contentStarted = false;

  constructor(
    private readonly input: SendDesktopChatMessageInput,
    private readonly emitEvent: (event: DesktopChatMessageEvent) => void,
  ) {}

  accept(event: ModelEvent): void {
    // Project model events into the narrow renderer-visible reasoning and content stream.
    if (event.type === "reasoning-delta" && event.text !== "" && !this.contentStarted) {
      this.reasoningStarted = true;
      this.reasoningCompleted = false;
      this.emit("reasoning-delta", event.text);
    } else if (event.type === "text-delta" && event.text !== "") {
      this.contentStarted = true;
      this.completeReasoning();
      this.emit("content-delta", event.text);
    } else if (event.type === "done") {
      this.completeReasoning();
    }
  }

  completeReasoning(): void {
    if (!this.reasoningStarted || this.reasoningCompleted) return;
    this.reasoningCompleted = true;
    this.emitEvent(
      desktopChatMessageEventSchema.parse({
        type: "reasoning-complete",
        requestId: this.input.requestId,
        conversationId: this.input.conversationId,
      }),
    );
  }

  private emit(type: "reasoning-delta" | "content-delta", text: string): void {
    this.emitEvent(
      desktopChatMessageEventSchema.parse({
        type,
        requestId: this.input.requestId,
        conversationId: this.input.conversationId,
        text,
      }),
    );
  }
}

function resolveConversationContextBudget(providerId: string, model: string) {
  // Resolve the catalog-backed context budget for an existing conversation identity.
  const config = getSoftwareConfig();
  const configuredModel = config.llm.providers[providerId]?.models[model];
  if (configuredModel === undefined) {
    throw new AppError("CONFIG_ERROR", `模型 ${providerId}/${model} 缺少能力配置。`);
  }
  return createContextBudgetPolicy(configuredModel, config.context);
}
