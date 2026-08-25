import { ArrowUp, ChevronDown } from "lucide-react";
import { useLayoutEffect, useRef, type FormEvent, type KeyboardEvent, type ReactNode } from "react";

import { Button } from "../ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu.js";
import { Textarea } from "../ui/textarea.js";

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
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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
    approval?.onAllowOnce();
  }

  function reject(): void {
    approval?.onReject();
  }

  function allowUntilExit(): void {
    approval?.onAllowUntilExit();
  }

  return (
    <form
      className="m-3 mb-3 grid grid-rows-[minmax(72px,auto)_auto] gap-1.5 rounded-[14px] border border-border bg-surface-raised p-2"
      onSubmit={submit}
    >
      <Textarea
        ref={textareaRef}
        className="min-h-[72px] max-h-64 resize-none border-0 bg-transparent px-2 py-[7px] text-[11px] leading-relaxed shadow-none focus-visible:border-0 focus-visible:ring-0"
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        aria-label="聊天输入"
        rows={3}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={handleKeyDown}
      />
      <div className="flex min-h-[34px] items-center justify-end gap-2">
        {approval === null ? null : (
          <div className="flex items-center overflow-hidden rounded-md">
            <Button
              type="button"
              size="sm"
              className="h-[34px] rounded-r-none px-3 text-[11px]"
              onClick={allowOnce}
            >
              请求{approval.approvalLabel}：允许
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  size="icon-xs"
                  className="h-[34px] w-7 rounded-l-none border-l border-primary-foreground/20"
                  aria-label="展开授权选项"
                >
                  <ChevronDown className="size-[14px]" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="end">
                <DropdownMenuItem variant="destructive" onSelect={reject}>
                  拒绝
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={allowUntilExit}>总是允许</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
        <Button
          type="submit"
          size="icon"
          disabled={disabled || value.trim().length === 0}
          aria-label="发送消息"
        >
          <ArrowUp />
        </Button>
      </div>
    </form>
  );
}
