import type {
  CleoDocDesktopApi,
  DesktopChatMessageEvent,
  SendDesktopChatMessageResult,
} from "../../shared/desktop-api.js";

export interface DesktopChatRequest {
  readonly requestId: string;
  readonly result: Promise<SendDesktopChatMessageResult>;
}

export class DesktopChatClient {
  constructor(
    private readonly api: Pick<CleoDocDesktopApi, "sendChatMessage" | "onChatMessageEvent">,
  ) {}

  continueConversation(
    conversationId: string,
    prompt: string,
    onEvent: (event: DesktopChatMessageEvent) => void,
  ): DesktopChatRequest {
    // Bind one chat command to only its correlated stream events and subscription lifetime.
    // 1. Generate the request identity before subscribing so early events cannot be missed.
    // 2. Filter the shared IPC event channel by both request and conversation identity.
    // 3. Remove the temporary listener after the command succeeds or fails.
    const requestId = crypto.randomUUID();
    const dispose = this.api.onChatMessageEvent((event) => {
      if (event.requestId === requestId && event.conversationId === conversationId) onEvent(event);
    });
    const result = this.api.sendChatMessage({ requestId, conversationId, prompt }).finally(dispose);
    return { requestId, result };
  }
}
