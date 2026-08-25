import { useEffect, useRef, useState, type ReactNode } from "react";

import type { DesktopConversationMessage } from "../../../../shared/desktop-api.js";

export interface ConversationMessageProps {
  readonly message: DesktopConversationMessage;
  readonly reasoningStreaming?: boolean;
}

export function ConversationMessage({
  message,
  reasoningStreaming = false,
}: ConversationMessageProps): ReactNode {
  // Render a visible message with user-controlled or stream-controlled assistant reasoning.
  // 1. Normalize reasoning and track whether its live stream has just completed.
  // 2. Force live reasoning open, then force its first completed render closed.
  // 3. Preserve ordinary manual disclosure behavior for persisted messages.
  // 4. Keep all reasoning content outside the assistant content bubble.
  const [reasoningExpanded, setReasoningExpanded] = useState(false);
  const wasReasoningStreaming = useRef(false);
  const reasoning = message.reasoningContent?.trim() ?? "";
  const displayedReasoningExpanded = resolveReasoningExpanded(
    reasoningStreaming,
    wasReasoningStreaming.current,
    reasoningExpanded,
  );

  useEffect(() => {
    if (reasoningStreaming) setReasoningExpanded(true);
    else if (wasReasoningStreaming.current) setReasoningExpanded(false);
    wasReasoningStreaming.current = reasoningStreaming;
  }, [reasoningStreaming]);

  return (
    <article className={`conversation-message ${message.role}`}>
      {message.role === "assistant" && reasoning !== "" ? (
        <div className="message-reasoning-wrap">
          <button
            type="button"
            className="message-reasoning-toggle"
            aria-expanded={displayedReasoningExpanded}
            aria-controls={`reasoning-${message.id}`}
            onClick={() => setReasoningExpanded((expanded) => !expanded)}
          >
            <span>思考</span>
            <span aria-hidden="true">{displayedReasoningExpanded ? "▾" : "▸"}</span>
          </button>
          {displayedReasoningExpanded ? (
            <div id={`reasoning-${message.id}`} className="message-reasoning-content">
              {reasoning}
            </div>
          ) : null}
        </div>
      ) : null}
      {message.content.trim() !== "" ? (
        <div className="conversation-message-bubble">{message.content}</div>
      ) : null}
    </article>
  );
}

export function resolveReasoningExpanded(
  reasoningStreaming: boolean,
  wasReasoningStreaming: boolean,
  userExpanded: boolean,
): boolean {
  if (reasoningStreaming) return true;
  if (wasReasoningStreaming) return false;
  return userExpanded;
}
