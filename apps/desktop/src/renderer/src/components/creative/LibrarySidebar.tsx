import type { ReactNode } from "react";

export interface LibrarySidebarProps {
  readonly title: string;
  readonly description: string;
  readonly listLabel: string;
  readonly itemCount: number;
  readonly emptyIcon: ReactNode;
  readonly content?: ReactNode;
}

export function LibrarySidebar({
  title,
  description,
  listLabel,
  itemCount,
  emptyIcon,
  content,
}: LibrarySidebarProps): ReactNode {
  // Render the common list shell used by the works and materials sidebars.
  // 1. Show the current feature heading and list summary.
  // 2. Render feature-owned content or the existing empty state.
  return (
    <aside className="library-panel">
      <div className="panel-heading">
        <div>
          <h1>{title}</h1>
          <p>{description}</p>
        </div>
      </div>

      <div className="list-heading">
        <span>{listLabel}</span>
        <small>{itemCount} 项</small>
      </div>

      {content ?? (
        <div className="panel-empty">
          <div className="empty-mini-icon">{emptyIcon}</div>
          <strong>暂无内容</strong>
          <span>项目打开后将在这里显示</span>
        </div>
      )}
    </aside>
  );
}
