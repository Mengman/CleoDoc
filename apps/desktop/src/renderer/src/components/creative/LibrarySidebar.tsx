import {
  ChevronDown as ChevronIcon,
  FileText as DocumentIcon,
  Plus as PlusIcon,
  Search as SearchIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import type { DesktopProjectState } from "../../../../shared/desktop-api.js";

export interface LibrarySidebarProps {
  readonly title: string;
  readonly description: string;
  readonly searchLabel: string;
  readonly listLabel: string;
  readonly itemCount: number;
  readonly emptyIcon: ReactNode;
  readonly projectState: DesktopProjectState;
}

export function LibrarySidebar({
  title,
  description,
  searchLabel,
  listLabel,
  itemCount,
  emptyIcon,
  projectState,
}: LibrarySidebarProps): ReactNode {
  // Render the common list shell used by the works and materials sidebars.
  // 1. Show the current feature heading, search field, and active project summary.
  // 2. Reserve the list area for the feature-specific data connected in later stages.
  return (
    <aside className="library-panel">
      <div className="panel-heading">
        <div>
          <h1>{title}</h1>
          <p>{description}</p>
        </div>
        <button className="square-button" type="button" disabled aria-label="添加">
          <PlusIcon />
        </button>
      </div>

      <label className="search-box">
        <SearchIcon />
        <input type="search" disabled placeholder={searchLabel} aria-label={searchLabel} />
      </label>

      <div className="project-card">
        <div className="project-mark">
          <DocumentIcon />
        </div>
        <div>
          <span>当前项目</span>
          <strong>{projectState.status === "open" ? projectState.project.name : "未打开"}</strong>
        </div>
        <ChevronIcon />
      </div>

      <div className="list-heading">
        <span>{listLabel}</span>
        <small>{itemCount} 项</small>
      </div>

      <div className="panel-empty">
        <div className="empty-mini-icon">{emptyIcon}</div>
        <strong>暂无内容</strong>
        <span>项目打开后将在这里显示</span>
      </div>
    </aside>
  );
}
