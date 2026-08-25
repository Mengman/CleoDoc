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
    <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)]">
      <header className="flex min-h-[52px] items-center border-b border-border bg-surface px-[18px]">
        <h2 className="m-0 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[13px] text-foreground">
          对话
        </h2>
      </header>
      {loading ? (
        <p className="mx-[18px] my-6 text-center text-[10px] text-muted-foreground">
          正在加载对话…
        </p>
      ) : null}
      {error !== null ? (
        <p className="mx-[18px] my-6 text-center text-[10px] text-destructive">{error}</p>
      ) : null}
      {!loading && error === null && conversations.length === 0 ? (
        <div className="grid content-center justify-items-center gap-2.5 px-5 py-12 text-center text-muted-foreground">
          <MessageSquareText className="size-7 text-primary" />
          <strong className="text-xs text-foreground">当前项目暂无对话</strong>
        </div>
      ) : null}
      {conversations.length > 0 ? (
        <div
          ref={listReference}
          className="grid min-h-0 content-start gap-1.5 overflow-x-hidden overflow-y-auto p-3 [scrollbar-gutter:stable]"
          onScroll={handleScroll}
        >
          {conversations.map((conversation) => (
            <button
              key={conversation.id}
              type="button"
              className="grid w-full grid-cols-[24px_minmax(0,1fr)] items-center gap-2.5 rounded-lg border border-transparent bg-transparent p-3 text-left text-muted-foreground hover:border-border hover:bg-accent hover:text-foreground [&>svg]:size-[17px] [&>svg]:text-primary"
              onClick={() => onSelect(conversation)}
            >
              <MessageSquareText />
              <span className="overflow-hidden text-ellipsis whitespace-nowrap text-[11px]">
                {conversation.title?.trim() || "未命名对话"}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
