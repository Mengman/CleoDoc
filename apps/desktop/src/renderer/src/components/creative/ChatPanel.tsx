import { ArrowRight as ArrowIcon, Plus as PlusIcon, Sparkles as SparkleIcon } from "lucide-react";
import type { ReactNode } from "react";

export function ChatPanel(): ReactNode {
  // Render the chat surface independently from the selected left sidebar.
  // 1. Keep the conversation stream unchanged when works and materials navigation switches.
  // 2. Anchor the existing disabled composer at the bottom until chat is connected.
  return (
    <aside className="chat-panel">
      <div className="conversation-stream" role="log" aria-label="聊天内容" aria-live="polite">
        <article className="message-row">
          <div className="assistant-avatar">C</div>
          <div className="message-content">
            <div className="message-author">
              <strong>Cleo · 主笔 Agent</strong>
              <span>本地工作区已准备好</span>
            </div>
            <div className="welcome-card">
              <SparkleIcon />
              <h3>欢迎来到 CleoDoc</h3>
              <p>打开项目后，你可以在这里与主笔对话、检索资料，并审批文档写入。</p>
            </div>
          </div>
        </article>
      </div>

      <div className="composer-wrap">
        <div className="composer disabled">
          <textarea disabled placeholder="打开项目后即可与主笔对话…" />
          <div className="composer-actions">
            <span>
              <PlusIcon /> 添加上下文
            </span>
            <button type="button" disabled aria-label="发送">
              <ArrowIcon />
            </button>
          </div>
        </div>
        <small>所有操作都限定在当前项目范围内</small>
      </div>
    </aside>
  );
}
