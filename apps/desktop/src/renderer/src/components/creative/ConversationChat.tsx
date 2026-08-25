import { ArrowLeft } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";

import type {
  DesktopConversationItem,
  DesktopConversationMessage,
} from "../../../../shared/desktop-api.js";
import { Button } from "../ui/button.js";
import { ConversationMessage } from "./ConversationMessage.js";

export interface ConversationChatProps {
  readonly conversation: DesktopConversationItem;
  readonly messages: readonly DesktopConversationMessage[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly streamingReasoningMessageId: string | null;
  readonly onBack: () => void;
}

export function ConversationChat({
  conversation,
  messages,
  loading,
  error,
  streamingReasoningMessageId,
  onBack,
}: ConversationChatProps): ReactNode {
  // Keep the selected conversation title fixed and its newest messages in view.
  // 1. Scroll to the bottom after messages finish loading or a reply completes.
  // 2. Keep navigation outside the scrollable message stream.
  // 3. Render loading, error, empty, or current message states in the stream.
  const streamReference = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!loading && error === null) {
      streamReference.current?.scrollTo({ top: streamReference.current.scrollHeight });
    }
  }, [error, loading, messages]);

  return (
    <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)]">
      <header className="flex min-h-[52px] items-center gap-2.5 border-b border-border bg-surface px-[18px]">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={onBack}
          aria-label="返回对话列表"
        >
          <ArrowLeft />
        </Button>
        <h2 className="m-0 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[13px] text-foreground">
          {conversation.title?.trim() || "未命名对话"}
        </h2>
      </header>
      <div
        ref={streamReference}
        className="min-h-0 overflow-x-hidden overflow-y-auto p-[18px] [scrollbar-gutter:stable]"
        role="log"
        aria-label="当前对话"
      >
        {loading ? (
          <p className="my-6 text-center text-[10px] text-muted-foreground">正在加载对话…</p>
        ) : null}
        {error !== null ? (
          <p className="my-6 text-center text-[10px] text-destructive">{error}</p>
        ) : null}
        {!loading && error === null && messages.length === 0 ? (
          <p className="my-6 text-center text-[10px] text-muted-foreground">
            当前对话暂无可显示的消息
          </p>
        ) : null}
        {messages.map((message) => (
          <ConversationMessage
            key={message.id}
            message={message}
            reasoningStreaming={message.id === streamingReasoningMessageId}
          />
        ))}
      </div>
    </div>
  );
}
