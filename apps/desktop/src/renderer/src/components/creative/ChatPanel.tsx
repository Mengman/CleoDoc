import { MessageSquareText } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import type {
  DesktopConversationItem,
  DesktopConversationMessage,
  DesktopProjectState,
} from "../../../../shared/desktop-api.js";
import { ChatComposer } from "./ChatComposer.js";
import { ConversationChat } from "./ConversationChat.js";
import { ConversationList } from "./ConversationList.js";

export interface ChatPanelProps {
  readonly projectState: DesktopProjectState;
}

export function ChatPanel({ projectState }: ChatPanelProps): ReactNode {
  // Coordinate project-bound conversation browsing, drafting, and message submission.
  // 1. Reset conversation data and drafts only when the active project changes or closes.
  // 2. Load the list and selected conversation through the typed desktop boundary.
  // 3. Keep an independent unsent draft for every opened conversation.
  // 4. Stream reasoning and content only while continuing an existing conversation.
  const projectId = projectState.status === "open" ? projectState.project.id : null;
  const requestVersion = useRef(0);
  const selectedConversationId = useRef<string | null>(null);
  const [conversations, setConversations] = useState<readonly DesktopConversationItem[]>([]);
  const [selected, setSelected] = useState<DesktopConversationItem | null>(null);
  const [messages, setMessages] = useState<readonly DesktopConversationMessage[]>([]);
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({});
  const [listScrollTop, setListScrollTop] = useState(0);
  const [loading, setLoading] = useState(false);
  const activeRequestId = useRef<string | null>(null);
  const [activeSendingConversationId, setActiveSendingConversationId] = useState<string | null>(
    null,
  );
  const [streamingReasoningMessageId, setStreamingReasoningMessageId] = useState<string | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    requestVersion.current += 1;
    const version = requestVersion.current;
    let active = true;
    setConversations([]);
    setSelected(null);
    selectedConversationId.current = null;
    setMessages([]);
    setDrafts({});
    setListScrollTop(0);
    setError(null);
    if (projectId === null) return () => undefined;
    setLoading(true);
    void window.cleodoc
      .listConversations()
      .then((result) => {
        if (!active || version !== requestVersion.current) return;
        if (result.outcome === "error") setError(result.error.message);
        else setConversations(result.conversations);
      })
      .catch(() => {
        if (active && version === requestVersion.current) setError("无法加载项目对话");
      })
      .finally(() => {
        if (active && version === requestVersion.current) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [projectId]);

  useEffect(() => {
    // Merge validated model deltas into the temporary assistant message for the active request.
    return window.cleodoc.onChatMessageEvent((event) => {
      if (
        event.requestId !== activeRequestId.current ||
        event.conversationId !== selectedConversationId.current
      )
        return;
      const messageId = `streaming-${event.requestId}`;
      if (event.type === "reasoning-complete") {
        setStreamingReasoningMessageId(null);
        return;
      }
      setMessages((current) =>
        updateStreamingAssistantMessage(current, messageId, event.type, event.text),
      );
      if (event.type === "reasoning-delta") setStreamingReasoningMessageId(messageId);
    });
  }, []);

  function openConversation(conversation: DesktopConversationItem): void {
    // Load the selected conversation without allowing an older response to replace it.
    // 1. Publish the selection immediately and invalidate earlier requests.
    // 2. Read the bounded messages through Typed IPC.
    // 3. Apply only the newest response and settle its loading state.
    requestVersion.current += 1;
    const version = requestVersion.current;
    selectedConversationId.current = conversation.id;
    setSelected(conversation);
    setMessages([]);
    setError(null);
    setLoading(true);
    void window.cleodoc
      .getConversationHistory({ conversationId: conversation.id })
      .then((result) => {
        if (version !== requestVersion.current) return;
        if (result.outcome === "error") setError(result.error.message);
        else {
          setSelected(result.conversation);
          setMessages(result.messages);
        }
      })
      .catch(() => {
        if (version === requestVersion.current) setError("无法加载当前对话");
      })
      .finally(() => {
        if (version === requestVersion.current) setLoading(false);
      });
  }

  function updateDraft(value: string): void {
    if (selected !== null) setDrafts((current) => ({ ...current, [selected.id]: value }));
  }

  async function sendMessage(): Promise<void> {
    // Continue the selected conversation while rendering its reply from streamed deltas.
    // 1. Require an existing conversation and append an optimistic user message.
    // 2. Correlate reasoning and content events with this specific request.
    // 3. Replace temporary messages with persisted results after generation settles.
    const conversation = selected;
    if (conversation === null) return;
    const draftKey = conversation.id;
    const prompt = (drafts[draftKey] ?? "").trim();
    if (prompt.length === 0 || activeRequestId.current !== null) return;

    requestVersion.current += 1;
    const requestId = crypto.randomUUID();
    activeRequestId.current = requestId;
    setActiveSendingConversationId(conversation.id);
    setError(null);
    setDrafts((current) => ({ ...current, [draftKey]: "" }));
    setMessages((current) => [...current, createOptimisticUserMessage(requestId, prompt)]);
    try {
      const result = await window.cleodoc.sendChatMessage({
        requestId,
        conversationId: conversation.id,
        prompt,
      });
      if (result.outcome === "error") {
        if (selectedConversationId.current === conversation.id) {
          setError(result.error.message);
          setDrafts((current) => ({ ...current, [draftKey]: prompt }));
          setMessages((current) => removeTemporaryMessages(current, requestId));
        }
        return;
      }
      setConversations((current) => [
        result.conversation,
        ...current.filter((item) => item.id !== result.conversation.id),
      ]);
      if (selectedConversationId.current === result.conversation.id) {
        setSelected(result.conversation);
        setMessages(result.messages);
      }
    } catch {
      if (selectedConversationId.current === conversation.id) {
        setError("消息发送失败，请稍后重试");
        setDrafts((current) => ({ ...current, [draftKey]: prompt }));
        setMessages((current) => removeTemporaryMessages(current, requestId));
      }
    } finally {
      if (activeRequestId.current === requestId) activeRequestId.current = null;
      setStreamingReasoningMessageId(null);
      setActiveSendingConversationId(null);
    }
  }

  if (projectState.status === "closed") {
    return (
      <aside className="chat-panel chat-panel-closed">
        <MessageSquareText />
        <strong>尚未打开项目</strong>
        <span>通过文件菜单打开项目后，这里将展示项目对话。</span>
      </aside>
    );
  }

  return (
    <aside className="chat-panel">
      {selected === null ? (
        <ConversationList
          conversations={conversations}
          loading={loading}
          error={error}
          scrollTop={listScrollTop}
          onSelect={openConversation}
          onScrollTopChange={setListScrollTop}
        />
      ) : (
        <ConversationChat
          conversation={selected}
          messages={messages}
          loading={loading}
          error={error}
          streamingReasoningMessageId={streamingReasoningMessageId}
          onBack={() => {
            requestVersion.current += 1;
            selectedConversationId.current = null;
            setSelected(null);
            setMessages([]);
            setError(null);
            setLoading(false);
          }}
        />
      )}
      {selected === null ? null : (
        <ChatComposer
          value={drafts[selected.id] ?? ""}
          disabled={activeSendingConversationId === selected.id}
          placeholder="继续当前对话…"
          onChange={updateDraft}
          onSend={() => void sendMessage()}
        />
      )}
    </aside>
  );
}

export function createOptimisticUserMessage(
  requestId: string,
  content: string,
): DesktopConversationMessage {
  // Create the temporary user message shown before persistence completes.
  return {
    id: `optimistic-${requestId}`,
    role: "user",
    content,
    sequence: Number.MAX_SAFE_INTEGER - 1,
    createdAt: new Date().toISOString(),
  };
}

export function updateStreamingAssistantMessage(
  messages: readonly DesktopConversationMessage[],
  messageId: string,
  eventType: "reasoning-delta" | "content-delta",
  text: string,
): readonly DesktopConversationMessage[] {
  // Merge a model delta into the single temporary assistant message for this request.
  // 1. Create the assistant placeholder when the first reasoning or content delta arrives.
  // 2. Keep reasoning and final content in their separate message fields.
  // 3. Append later deltas without changing the order of surrounding messages.
  const existing = messages.find((message) => message.id === messageId);
  if (existing === undefined) {
    return [
      ...messages,
      {
        id: messageId,
        role: "assistant",
        content: eventType === "content-delta" ? text : "",
        ...(eventType === "reasoning-delta" ? { reasoningContent: text } : {}),
        sequence: Number.MAX_SAFE_INTEGER,
        createdAt: new Date().toISOString(),
      },
    ];
  }
  return messages.map((message) =>
    message.id !== messageId
      ? message
      : {
          ...message,
          content: eventType === "content-delta" ? message.content + text : message.content,
          ...(eventType === "reasoning-delta"
            ? { reasoningContent: (message.reasoningContent ?? "") + text }
            : {}),
        },
  );
}

export function removeTemporaryMessages(
  messages: readonly DesktopConversationMessage[],
  requestId: string,
): readonly DesktopConversationMessage[] {
  // Remove both optimistic messages when the corresponding request fails.
  return messages.filter(
    (message) =>
      message.id !== `optimistic-${requestId}` && message.id !== `streaming-${requestId}`,
  );
}
