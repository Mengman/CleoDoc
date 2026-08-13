import { ArrowUp } from "lucide-react";
import type { FormEvent, KeyboardEvent, ReactNode } from "react";

export interface ChatComposerProps {
  readonly value: string;
  readonly disabled: boolean;
  readonly placeholder: string;
  readonly onChange: (value: string) => void;
  readonly onSend: () => void;
}

export function ChatComposer({
  value,
  disabled,
  placeholder,
  onChange,
  onSend,
}: ChatComposerProps): ReactNode {
  // Render a controlled composer that supports keyboard and button submission.
  // 1. Keep the textarea value owned by the parent so conversation drafts can be switched.
  // 2. Submit on Enter while preserving Shift+Enter for multiline prompts.
  // 3. Disable every submission path while a request is active or the draft is empty.
  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!disabled && value.trim().length > 0) onSend();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (!disabled && value.trim().length > 0) onSend();
  }

  return (
    <form className="chat-composer" onSubmit={submit}>
      <textarea
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        aria-label="聊天输入"
        rows={3}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={handleKeyDown}
      />
      <button type="submit" disabled={disabled || value.trim().length === 0} aria-label="发送消息">
        <ArrowUp />
      </button>
      <span>Enter 发送 · Shift+Enter 换行</span>
    </form>
  );
}
