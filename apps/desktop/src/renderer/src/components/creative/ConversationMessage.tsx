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
    <article
      className={`mb-4 grid ${message.role === "user" ? "justify-items-end" : "justify-items-start"}`}
    >
      {message.role === "assistant" && reasoning !== "" ? (
        <div className="mb-1.5 w-[88%]">
          <button
            type="button"
            className="flex items-center gap-1 bg-transparent p-0 text-[7.33px] text-muted-foreground hover:text-foreground"
            aria-expanded={displayedReasoningExpanded}
            aria-controls={`reasoning-${message.id}`}
            onClick={() => setReasoningExpanded((expanded) => !expanded)}
          >
            <span>思考</span>
            <span aria-hidden="true">{displayedReasoningExpanded ? "▾" : "▸"}</span>
          </button>
          {displayedReasoningExpanded ? (
            <div
              id={`reasoning-${message.id}`}
              className="mt-[7px] border-l border-border pl-2 text-[9px] leading-relaxed text-muted-foreground whitespace-pre-wrap break-words"
            >
              {reasoning}
            </div>
          ) : null}
        </div>
      ) : null}
      {message.content.trim() !== "" ? (
        <div
          className={`max-w-[88%] whitespace-pre-wrap break-words border px-3 py-2.5 text-[11px] leading-relaxed ${
            message.role === "user"
              ? "rounded-[13px_4px_13px_13px] border-primary/60 bg-primary text-primary-foreground"
              : "rounded-[4px_13px_13px_13px] border-border bg-secondary text-foreground"
          }`}
        >
          {message.content}
        </div>
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
