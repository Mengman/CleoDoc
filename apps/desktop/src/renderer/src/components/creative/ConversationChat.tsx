import { ArrowLeft } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";

import type {
  DesktopConversationItem,
  DesktopConversationMessage,
} from "../../../../shared/desktop-api.js";
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
    <div className="conversation-chat">
      <header className="conversation-chat-header">
        <button type="button" onClick={onBack} aria-label="返回对话列表">
          <ArrowLeft />
        </button>
        <h2>{conversation.title?.trim() || "未命名对话"}</h2>
      </header>
      <div
        ref={streamReference}
        className="conversation-chat-stream"
        role="log"
        aria-label="当前对话"
      >
        {loading ? <p className="chat-panel-state">正在加载对话…</p> : null}
        {error !== null ? <p className="chat-panel-state error">{error}</p> : null}
        {!loading && error === null && messages.length === 0 ? (
          <p className="chat-panel-state">当前对话暂无可显示的消息</p>
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
