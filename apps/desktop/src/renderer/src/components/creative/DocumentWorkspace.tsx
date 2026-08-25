import {
  AlignLeft as TextIcon,
  BookOpen as OpenBookIcon,
  Eye as EyeIcon,
  FileCode2 as MarkdownIcon,
  X as CloseIcon,
} from "lucide-react";
import type { ReactNode } from "react";

export interface DocumentTab {
  readonly source: "manuscript" | "material";
  readonly reference: string;
  readonly content: string | null;
  readonly error: string | null;
}

export interface DocumentWorkspaceProps {
  readonly tabs: readonly DocumentTab[];
  readonly activeTabKey: string | null;
  readonly onActivate: (tab: DocumentTab) => void;
  readonly onClose: (tab: DocumentTab) => void;
}

export function DocumentWorkspace({
  tabs,
  activeTabKey,
  onActivate,
  onClose,
}: DocumentWorkspaceProps): ReactNode {
  // Render the shared manuscript and material tabs as unformatted text.
  // 1. Keep every opened document in one ordered tab bar with activation and close actions.
  // 2. Show the existing empty surface or the active tab's loading, error, or text content.
  // 3. Preserve original text line breaks and report the active project-relative path.
  const activeTab = tabs.find((tab) => documentTabKey(tab) === activeTabKey) ?? null;

  return (
    <main className="document-workspace grid min-h-0 min-w-0 grid-rows-[52px_minmax(0,1fr)] overflow-hidden bg-background">
      <div className="document-tab-bar flex items-center justify-between border-b border-border bg-surface px-5">
        <div
          className="flex min-w-0 self-stretch overflow-x-auto overflow-y-hidden"
          role="tablist"
          aria-label="已打开文档"
        >
          {tabs.map((tab) => (
            <div
              key={documentTabKey(tab)}
              className={`flex min-w-0 max-w-[200px] flex-none items-center self-stretch border-b-2 ${
                documentTabKey(tab) === activeTabKey
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground"
              }`}
              title={documentLocation(tab)}
            >
              <button
                className="min-w-0 overflow-hidden px-1 pb-0 pt-0 text-ellipsis whitespace-nowrap text-[11px]"
                type="button"
                role="tab"
                aria-selected={documentTabKey(tab) === activeTabKey}
                onClick={() => onActivate(tab)}
              >
                {documentTitle(tab)}
              </button>
              <button
                className="mr-[3px] grid size-6 flex-none place-items-center rounded-[5px] text-muted-foreground hover:bg-accent hover:text-foreground [&>svg]:size-[13px]"
                type="button"
                aria-label={`关闭 ${documentTitle(tab)}`}
                onClick={() => onClose(tab)}
              >
                <CloseIcon />
              </button>
            </div>
          ))}
        </div>
        <div className="ml-3 flex flex-none items-center gap-2">
          <span className="flex items-center gap-1.5 rounded-full bg-secondary px-2.5 py-[7px] text-[10px] text-success [&>svg]:size-[13px]">
            <EyeIcon /> 只读模式
          </span>
        </div>
      </div>

      <section className="document-viewer grid min-h-0 overflow-x-hidden overflow-y-auto p-5 [scrollbar-gutter:stable]">
        {activeTab === null ? (
          <EmptyDocumentSurface />
        ) : activeTab.error !== null ? (
          <DocumentState message={activeTab.error} error />
        ) : activeTab.content === null ? (
          <DocumentState message="正在读取文档…" />
        ) : (
          <article className="relative m-auto block min-h-full w-full max-w-[760px] overflow-visible rounded-2xl border border-border bg-surface px-16 py-[54px] text-left shadow-lg max-[1320px]:p-11">
            <div className="absolute inset-x-0 top-0 h-[5px] bg-gradient-to-r from-primary to-primary/80" />
            <pre className="m-0 whitespace-pre-wrap break-words font-sans text-[15px] leading-[1.9] text-foreground">
              {activeTab.content}
            </pre>
          </article>
        )}
      </section>
    </main>
  );
}

function EmptyDocumentSurface(): ReactNode {
  // Render the existing reader guidance while no document tab is active.
  // 1. Preserve the workspace identity and read-only visual surface.
  // 2. Describe the two supported source formats without enabling editing actions.
  return (
    <div className="relative m-auto grid min-h-[520px] w-full max-w-[760px] content-center justify-items-center overflow-hidden rounded-2xl border border-border bg-surface p-16 text-center shadow-lg">
      <div className="absolute inset-x-0 top-0 h-[5px] bg-gradient-to-r from-primary to-primary/80" />
      <div className="mb-5 grid size-[76px] place-items-center rounded-[24px] border border-border bg-accent text-accent-foreground [&>svg]:size-[38px]">
        <OpenBookIcon />
      </div>
      <p className="mb-2.5 text-[10px] font-bold tracking-[0.2em] text-primary">
        CLEODOC WORKSPACE
      </p>
      <h2 className="m-0 text-4xl tracking-tight text-foreground">打开作品或资料开始阅读</h2>
      <p className="mb-6 mt-3.5 max-w-[480px] text-[13px] leading-relaxed text-muted-foreground">
        作品和资料会在同一组标签页中打开，切换左侧导航不会改变当前文档。
      </p>
      <div className="flex items-center gap-2.5">
        <span className="flex items-center gap-[7px] rounded-md border border-border bg-secondary px-3 py-[9px] text-[10px] text-muted-foreground [&>svg]:size-[15px] [&>svg]:text-primary">
          <MarkdownIcon /> Markdown 阅读
        </span>
        <span className="flex items-center gap-[7px] rounded-md border border-border bg-secondary px-3 py-[9px] text-[10px] text-muted-foreground [&>svg]:size-[15px] [&>svg]:text-primary">
          <TextIcon /> 纯文本阅读
        </span>
      </div>
    </div>
  );
}

function DocumentState({
  message,
  error = false,
}: {
  message: string;
  error?: boolean;
}): ReactNode {
  return (
    <div className="relative m-auto grid min-h-[520px] w-full max-w-[760px] content-center justify-items-center overflow-hidden rounded-2xl border border-border bg-surface p-16 text-center shadow-lg">
      <div className="absolute inset-x-0 top-0 h-[5px] bg-gradient-to-r from-primary to-primary/80" />
      <strong className={`text-xs ${error ? "text-destructive" : "text-foreground"}`}>
        {message}
      </strong>
    </div>
  );
}

export function documentTabKey(tab: Pick<DocumentTab, "source" | "reference">): string {
  return `${tab.source}:${tab.reference}`;
}

function documentTitle(tab: DocumentTab): string {
  return tab.source === "manuscript"
    ? tab.reference.slice(tab.reference.lastIndexOf("/") + 1)
    : tab.reference;
}

function documentLocation(tab: DocumentTab): string {
  return tab.source === "manuscript" ? tab.reference : `资料/${tab.reference}`;
}
