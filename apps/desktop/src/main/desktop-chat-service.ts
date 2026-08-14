import { getSoftwareConfig } from "../../../../packages/config/src/index.js";
import { type ModelEvent, type StoredMessage } from "../../../../packages/contracts/src/index.js";
import {
  desktopChatMessageEventSchema,
  type DesktopChatMessageEvent,
  type SendDesktopChatMessageInput,
} from "../shared/desktop-api.js";
import type { DesktopProjectRuntime } from "./desktop-project-runtime.js";

export interface DesktopChatResult {
  readonly conversation: { readonly id: string; readonly title: string | null };
  readonly messages: readonly [DesktopTurnMessage<"user">, DesktopTurnMessage<"assistant">];
}

interface DesktopTurnMessage<Role extends "user" | "assistant"> {
  readonly id: string;
  readonly role: Role;
  readonly content: string;
  readonly reasoningContent?: string;
  readonly sequence: number;
  readonly createdAt: string;
}

export function createDesktopChatServiceOptions() {
  // Build the project chat runtime from the validated software configuration.
  const config = getSoftwareConfig();
  return {
    maxToolRounds: config.agent.maxToolRounds,
    context: config.context,
    compaction: config.agent.compaction,
  };
}

export class DesktopChatService {
  constructor(private readonly projects: DesktopProjectRuntime) {}

  send(
    input: SendDesktopChatMessageInput,
    emitEvent: (event: DesktopChatMessageEvent) => void,
  ): Promise<DesktopChatResult> {
    // Continue one existing conversation through the active project and desktop stream contract.
    // 1. Resolve the conversation within the active project.
    // 2. Send through ChatService and translate model deltas into renderer-safe desktop events.
    // 3. Return only the two visible messages persisted by the completed turn.
    return this.projects.runChatTask(async ({ projectId, signal, chat, conversations }) => {
      const conversation = conversations.getConversation(input.conversationId);
      const stream = new DesktopChatEventStream(input, emitEvent);
      const result = await chat.send({
        conversationId: conversation.id,
        projectId,
        prompt: input.prompt,
        signal,
        onEvent: (event) => stream.accept(event),
      });
      stream.completeReasoning();
      return {
        conversation: { id: conversation.id, title: conversation.title },
        messages: [
          toDesktopTurnMessage(result.userMessage),
          toDesktopTurnMessage(result.assistantMessage),
        ],
      };
    });
  }
}

function toDesktopTurnMessage<Role extends "user" | "assistant">(
  message: StoredMessage & { role: Role },
): DesktopTurnMessage<Role> {
  // Remove persistence-only fields from one message before it crosses the desktop boundary.
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    ...(message.reasoningContent === undefined
      ? {}
      : { reasoningContent: message.reasoningContent }),
    sequence: message.sequence,
    createdAt: message.createdAt,
  };
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
