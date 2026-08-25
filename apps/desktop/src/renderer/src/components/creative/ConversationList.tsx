import { MessageSquareText } from "lucide-react";
import { useEffect, useRef, type ReactNode, type UIEvent } from "react";

import type { DesktopConversationItem } from "../../../../shared/desktop-api.js";

export interface ConversationListProps {
  readonly conversations: readonly DesktopConversationItem[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly scrollTop: number;
  readonly onSelect: (conversation: DesktopConversationItem) => void;
  readonly onScrollTopChange: (scrollTop: number) => void;
}

export function ConversationList({
  conversations,
  loading,
  error,
  scrollTop,
  onSelect,
  onScrollTopChange,
}: ConversationListProps): ReactNode {
  // Render the current project's conversations in repository order.
  // 1. Restore the previous list position when returning from a conversation.
  // 2. Show loading, error, empty, or populated states without unsupported actions.
  // 3. Report scroll changes and forward the selected conversation to the parent panel.
  const listReference = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (listReference.current !== null) listReference.current.scrollTop = scrollTop;
  }, [scrollTop]);

  function handleScroll(event: UIEvent<HTMLDivElement>): void {
    onScrollTopChange(event.currentTarget.scrollTop);
  }

  return (
    <div className="conversation-browser">
      <header className="conversation-list-header">
        <h2>对话</h2>
      </header>
      {loading ? <p className="chat-panel-state">正在加载对话…</p> : null}
      {error !== null ? <p className="chat-panel-state error">{error}</p> : null}
      {!loading && error === null && conversations.length === 0 ? (
        <div className="conversation-list-empty">
          <MessageSquareText />
          <strong>当前项目暂无对话</strong>
        </div>
      ) : null}
      {conversations.length > 0 ? (
        <div ref={listReference} className="conversation-list-items" onScroll={handleScroll}>
          {conversations.map((conversation) => (
            <button
              key={conversation.id}
              type="button"
              className="conversation-list-item"
              onClick={() => onSelect(conversation)}
            >
              <MessageSquareText />
              <span>{conversation.title?.trim() || "未命名对话"}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
