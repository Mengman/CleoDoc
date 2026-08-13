import { useState, type ReactNode } from "react";

import type { DesktopConversationMessage } from "../../../../shared/desktop-api.js";

export interface ConversationMessageProps {
  readonly message: DesktopConversationMessage;
}

export function ConversationMessage({ message }: ConversationMessageProps): ReactNode {
  // Render a visible chat message with independently expandable assistant reasoning.
  // 1. Normalize reasoning to decide whether its disclosure control exists.
  // 2. Render reasoning content only after the user expands the control.
  // 3. Keep reasoning outside the user or assistant content bubble.
  const [reasoningExpanded, setReasoningExpanded] = useState(false);
  const reasoning = message.reasoningContent?.trim() ?? "";

  return (
    <article className={`conversation-message ${message.role}`}>
      {message.role === "assistant" && reasoning !== "" ? (
        <div className="message-reasoning-wrap">
          <button
            type="button"
            className="message-reasoning-toggle"
            aria-expanded={reasoningExpanded}
            aria-controls={`reasoning-${message.id}`}
            onClick={() => setReasoningExpanded((expanded) => !expanded)}
          >
            <span>思考</span>
            <span aria-hidden="true">{reasoningExpanded ? "▾" : "▸"}</span>
          </button>
          {reasoningExpanded ? (
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
