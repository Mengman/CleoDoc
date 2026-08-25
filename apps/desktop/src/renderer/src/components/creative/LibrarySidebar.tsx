import type { ReactNode } from "react";

export interface LibrarySidebarProps {
  readonly title: string;
  readonly description: string;
  readonly listLabel: string;
  readonly itemCount: number;
  readonly emptyIcon: ReactNode;
  readonly content?: ReactNode;
  readonly action?: ReactNode;
}

export function LibrarySidebar({
  title,
  description,
  listLabel,
  itemCount,
  emptyIcon,
  content,
  action,
}: LibrarySidebarProps): ReactNode {
  // Render the common list shell used by the works and materials sidebars.
  // 1. Show the current feature heading and list summary.
  // 2. Render feature-owned content or the existing empty state.
  return (
    <aside className="flex min-h-0 flex-col border-r border-border bg-surface px-3.5 py-[18px]">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="m-0 text-base text-foreground">{title}</h1>
          <p className="mb-0 mt-[5px] text-[11px] text-muted-foreground">{description}</p>
        </div>
        {action}
      </div>

      <div className="mx-1 mb-2.5 mt-2 flex justify-between text-[10px] tracking-[0.04em] text-muted-foreground">
        <span>{listLabel}</span>
        <small className="text-muted-foreground">{itemCount} 项</small>
      </div>

      {content ?? (
        <div className="grid justify-items-center gap-[7px] rounded-xl border border-dashed border-border px-3 py-[34px] text-center text-muted-foreground">
          <div className="grid size-[35px] place-items-center rounded-[10px] bg-accent text-accent-foreground [&>svg]:size-5">
            {emptyIcon}
          </div>
          <strong className="text-[11px] text-foreground">暂无内容</strong>
          <span className="text-[10px]">项目打开后将在这里显示</span>
        </div>
      )}
    </aside>
  );
}
