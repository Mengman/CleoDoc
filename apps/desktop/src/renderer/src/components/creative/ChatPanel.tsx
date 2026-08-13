import { MessageSquareText } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import type {
  DesktopChatMessageEvent,
  DesktopConversationItem,
  DesktopConversationMessage,
  DesktopProjectState,
} from "../../../../shared/desktop-api.js";
import { DesktopChatClient } from "../../desktop-chat-client.js";
import { ChatComposer } from "./ChatComposer.js";
import { ConversationChat } from "./ConversationChat.js";
import { ConversationList } from "./ConversationList.js";

export interface ChatPanelProps {
  readonly projectState: DesktopProjectState;
}

export function ChatPanel({ projectState }: ChatPanelProps): ReactNode {
  // Coordinate project-bound conversation browsing, drafting, and message submission.
  // 1. Reset conversation data and drafts only when the active project changes or closes.
  // 2. Load each selected conversation once and retain its messages while switching views.
  // 3. Keep an independent unsent draft for every opened conversation.
  // 4. Incrementally merge persisted turns and live reasoning/content into the retained list.
  const projectId = projectState.status === "open" ? projectState.project.id : null;
  const desktopChatClient = useRef(new DesktopChatClient(window.cleodoc)).current;
  const requestVersion = useRef(0);
  const selectedConversationId = useRef<string | null>(null);
  const [conversations, setConversations] = useState<readonly DesktopConversationItem[]>([]);
  const [selected, setSelected] = useState<DesktopConversationItem | null>(null);
  const [messagesByConversation, setMessagesByConversation] = useState<
    Readonly<Record<string, readonly DesktopConversationMessage[]>>
  >({});
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
    setMessagesByConversation({});
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

  function openConversation(conversation: DesktopConversationItem): void {
    // Load the selected conversation without allowing an older response to replace it.
    // 1. Publish the selection immediately and invalidate earlier requests.
    // 2. Read the bounded messages through Typed IPC.
    // 3. Apply only the newest response and settle its loading state.
    requestVersion.current += 1;
    const version = requestVersion.current;
    selectedConversationId.current = conversation.id;
    setSelected(conversation);
    setError(null);
    if (Object.hasOwn(messagesByConversation, conversation.id)) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void window.cleodoc
      .getConversationHistory({ conversationId: conversation.id })
      .then((result) => {
        if (version !== requestVersion.current) return;
        if (result.outcome === "error") setError(result.error.message);
        else {
          setSelected(result.conversation);
          setMessagesByConversation((current) => ({
            ...current,
            [conversation.id]: result.messages,
          }));
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

  async function sendMessage(prompt: string): Promise<void> {
    // Continue the selected conversation while applying desktop-client results to UI state.
    // 1. Append the submitted text optimistically and clear only that conversation's draft.
    // 2. Delegate IPC correlation and stream subscription lifetime to DesktopChatClient.
    // 3. Replace only this turn's temporary messages with its persisted incremental result.
    const conversation = selected;
    if (conversation === null) return;
    const draftKey = conversation.id;
    if (prompt.length === 0 || activeRequestId.current !== null) return;

    requestVersion.current += 1;
    const request = desktopChatClient.continueConversation(conversation.id, prompt, (event) =>
      acceptChatEvent(event),
    );
    const requestId = request.requestId;
    activeRequestId.current = requestId;
    setActiveSendingConversationId(conversation.id);
    setError(null);
    setDrafts((current) => ({ ...current, [draftKey]: "" }));
    setMessagesByConversation((current) => ({
      ...current,
      [conversation.id]: [
        ...(current[conversation.id] ?? []),
        createOptimisticUserMessage(requestId, prompt),
      ],
    }));
    try {
      const result = await request.result;
      if (result.outcome === "error") {
        if (selectedConversationId.current === conversation.id) {
          setError(result.error.message);
        }
        return;
      }
      setConversations((current) => [
        result.conversation,
        ...current.filter((item) => item.id !== result.conversation.id),
      ]);
      setMessagesByConversation((current) => ({
        ...current,
        [result.conversation.id]: replaceTemporaryMessages(
          current[result.conversation.id] ?? [],
          requestId,
          result.messages,
        ),
      }));
      if (selectedConversationId.current === result.conversation.id) {
        setSelected(result.conversation);
      }
    } catch {
      if (selectedConversationId.current === conversation.id) {
        setError("消息发送失败，请稍后重试");
      }
    } finally {
      if (activeRequestId.current === requestId) activeRequestId.current = null;
      setStreamingReasoningMessageId(null);
      setActiveSendingConversationId(null);
    }
  }

  function acceptChatEvent(event: DesktopChatMessageEvent): void {
    // Merge one correlated stream event into its retained conversation state.
    // 1. Complete reasoning only for the currently visible conversation.
    // 2. Append reasoning or content deltas to that conversation's temporary assistant message.
    // 3. Track active reasoning disclosure only while its conversation remains visible.
    const messageId = `streaming-${event.requestId}`;
    if (event.type === "reasoning-complete") {
      if (event.conversationId === selectedConversationId.current) {
        setStreamingReasoningMessageId(null);
      }
      return;
    }
    setMessagesByConversation((current) => ({
      ...current,
      [event.conversationId]: updateStreamingAssistantMessage(
        current[event.conversationId] ?? [],
        messageId,
        event.type,
        event.text,
      ),
    }));
    if (
      event.type === "reasoning-delta" &&
      event.conversationId === selectedConversationId.current
    ) {
      setStreamingReasoningMessageId(messageId);
    }
  }

  const messages = selected === null ? [] : (messagesByConversation[selected.id] ?? []);

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
          onSubmit={(prompt) => void sendMessage(prompt)}
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

export function replaceTemporaryMessages(
  messages: readonly DesktopConversationMessage[],
  requestId: string,
  persistedMessages: readonly DesktopConversationMessage[],
): readonly DesktopConversationMessage[] {
  // Replace only the completed turn while preserving every previously loaded message.
  const temporaryIds = new Set([`optimistic-${requestId}`, `streaming-${requestId}`]);
  const retained = messages.filter((message) => !temporaryIds.has(message.id));
  return [...retained, ...persistedMessages].sort((left, right) => left.sequence - right.sequence);
}
