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

const newConversationDraftKey = "new-conversation";

export interface ChatPanelProps {
  readonly projectState: DesktopProjectState;
}

export function ChatPanel({ projectState }: ChatPanelProps): ReactNode {
  // Coordinate project-bound conversation browsing, drafting, and message submission.
  // 1. Reset conversation data and drafts only when the active project changes or closes.
  // 2. Load the list and selected conversation through the typed desktop boundary.
  // 3. Keep an independent draft for the new-conversation view and every opened conversation.
  // 4. Send list-view input as a new conversation and selected-view input as a continuation.
  const projectId = projectState.status === "open" ? projectState.project.id : null;
  const requestVersion = useRef(0);
  const [conversations, setConversations] = useState<readonly DesktopConversationItem[]>([]);
  const [selected, setSelected] = useState<DesktopConversationItem | null>(null);
  const [messages, setMessages] = useState<readonly DesktopConversationMessage[]>([]);
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({});
  const [listScrollTop, setListScrollTop] = useState(0);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    requestVersion.current += 1;
    const version = requestVersion.current;
    let active = true;
    setConversations([]);
    setSelected(null);
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

  function openConversation(conversation: DesktopConversationItem): void {
    // Load the selected conversation without allowing an older response to replace it.
    // 1. Publish the selection immediately and invalidate earlier requests.
    // 2. Read the bounded messages through Typed IPC.
    // 3. Apply only the newest response and settle its loading state.
    requestVersion.current += 1;
    const version = requestVersion.current;
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
    const key = selected?.id ?? newConversationDraftKey;
    setDrafts((current) => ({ ...current, [key]: value }));
  }

  async function sendMessage(): Promise<void> {
    // Submit the active draft, update the conversation, and clear only the sent draft.
    // 1. Capture the selected conversation and its draft key before the asynchronous request.
    // 2. Send through Typed IPC while retaining the draft if submission fails.
    // 3. Open the returned conversation, refresh its messages, and move it to the list front.
    const conversation = selected;
    const draftKey = conversation?.id ?? newConversationDraftKey;
    const prompt = (drafts[draftKey] ?? "").trim();
    if (prompt.length === 0 || sending) return;

    requestVersion.current += 1;
    const version = requestVersion.current;
    setSending(true);
    setError(null);
    try {
      const result = await window.cleodoc.sendChatMessage({
        ...(conversation === null ? {} : { conversationId: conversation.id }),
        prompt,
      });
      if (result.outcome === "error") {
        if (version === requestVersion.current) setError(result.error.message);
        return;
      }
      setConversations((current) => [
        result.conversation,
        ...current.filter((item) => item.id !== result.conversation.id),
      ]);
      setDrafts((current) => ({ ...current, [draftKey]: "" }));
      if (version === requestVersion.current) {
        setSelected(result.conversation);
        setMessages(result.messages);
      }
    } catch {
      if (version === requestVersion.current) setError("消息发送失败，请稍后重试");
    } finally {
      setSending(false);
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

  const draftKey = selected?.id ?? newConversationDraftKey;
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
          onBack={() => {
            requestVersion.current += 1;
            setSelected(null);
            setMessages([]);
            setError(null);
            setLoading(false);
          }}
        />
      )}
      <ChatComposer
        value={drafts[draftKey] ?? ""}
        disabled={sending}
        placeholder={selected === null ? "输入消息，开启新对话…" : "继续当前对话…"}
        onChange={updateDraft}
        onSend={() => void sendMessage()}
      />
    </aside>
  );
}
