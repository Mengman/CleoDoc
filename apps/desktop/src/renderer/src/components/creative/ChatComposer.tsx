import { ArrowUp, ChevronDown } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";

export interface ChatApprovalActions {
  readonly approvalLabel: string;
  readonly onAllowOnce: () => void;
  readonly onReject: () => void;
  readonly onAllowUntilExit: () => void;
}

export interface ChatComposerProps {
  readonly value: string;
  readonly disabled: boolean;
  readonly placeholder: string;
  readonly approval: ChatApprovalActions | null;
  readonly onChange: (value: string) => void;
  readonly onSubmit: (value: string) => void;
}

export function ChatComposer({
  value,
  disabled,
  placeholder,
  approval,
  onChange,
  onSubmit,
}: ChatComposerProps): ReactNode {
  // Render a controlled composer that supports keyboard and button submission.
  // 1. Keep the textarea value owned by the parent so conversation drafts can be switched.
  // 2. Submit on Enter while preserving Shift+Enter for multiline prompts.
  // 3. Disable sending while a request is active or the draft is empty.
  const [approvalMenuOpen, setApprovalMenuOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (approval === null) setApprovalMenuOpen(false);
  }, [approval]);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (textarea === null) return;
    const maximumHeight = 256;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, maximumHeight)}px`;
  }, [value]);

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    submitValue();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    submitValue();
  }

  function submitValue(): void {
    const prompt = value.trim();
    if (!disabled && prompt.length > 0) onSubmit(prompt);
  }

  function allowOnce(): void {
    setApprovalMenuOpen(false);
    approval?.onAllowOnce();
  }

  function reject(): void {
    setApprovalMenuOpen(false);
    approval?.onReject();
  }

  function allowUntilExit(): void {
    setApprovalMenuOpen(false);
    approval?.onAllowUntilExit();
  }

  return (
    <form className="chat-composer" onSubmit={submit}>
      <textarea
        ref={textareaRef}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        aria-label="聊天输入"
        rows={3}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={handleKeyDown}
      />
      <div className="chat-composer-actions">
        {approval === null ? null : (
          <div className="chat-approval-control">
            <button type="button" className="chat-approval-allow" onClick={allowOnce}>
              请求{approval.approvalLabel}：允许
            </button>
            <button
              type="button"
              className="chat-approval-expand"
              aria-label="展开授权选项"
              aria-expanded={approvalMenuOpen}
              onClick={() => setApprovalMenuOpen((open) => !open)}
            >
              <ChevronDown />
            </button>
            {!approvalMenuOpen ? null : (
              <div className="chat-approval-menu">
                <button type="button" onClick={reject}>
                  拒绝
                </button>
                <button type="button" onClick={allowUntilExit}>
                  总是允许
                </button>
              </div>
            )}
          </div>
        )}
        <button
          type="submit"
          className="chat-send-button"
          disabled={disabled || value.trim().length === 0}
          aria-label="发送消息"
        >
          <ArrowUp />
        </button>
      </div>
    </form>
  );
}
