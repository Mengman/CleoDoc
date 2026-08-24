import {
  AlignLeft as TextIcon,
  BookOpen as OpenBookIcon,
  Eye as EyeIcon,
  FileCode2 as MarkdownIcon,
  X as CloseIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import type { DesktopRuntimeInfo } from "../../../../shared/desktop-api.js";

export interface DocumentTab {
  readonly source: "manuscript" | "material";
  readonly reference: string;
  readonly content: string | null;
  readonly error: string | null;
}

export interface DocumentWorkspaceProps {
  readonly tabs: readonly DocumentTab[];
  readonly activeTabKey: string | null;
  readonly runtimeInfo: DesktopRuntimeInfo | null;
  readonly onActivate: (tab: DocumentTab) => void;
  readonly onClose: (tab: DocumentTab) => void;
}

export function DocumentWorkspace({
  tabs,
  activeTabKey,
  runtimeInfo,
  onActivate,
  onClose,
}: DocumentWorkspaceProps): ReactNode {
  // Render the shared manuscript and material tabs as unformatted text.
  // 1. Keep every opened document in one ordered tab bar with activation and close actions.
  // 2. Show the existing empty surface or the active tab's loading, error, or text content.
  // 3. Preserve original text line breaks and report the active project-relative path.
  const activeTab = tabs.find((tab) => documentTabKey(tab) === activeTabKey) ?? null;

  return (
    <main className="reader-panel document-workspace">
      <div className="reader-tabs document-tab-bar">
        <div className="document-tabs" role="tablist" aria-label="已打开文档">
          {tabs.map((tab) => (
            <div
              key={documentTabKey(tab)}
              className={`reader-tab${documentTabKey(tab) === activeTabKey ? " active" : ""}`}
              title={documentLocation(tab)}
            >
              <button
                className="reader-tab-label"
                type="button"
                role="tab"
                aria-selected={documentTabKey(tab) === activeTabKey}
                onClick={() => onActivate(tab)}
              >
                {documentTitle(tab)}
              </button>
              <button
                className="reader-tab-close"
                type="button"
                aria-label={`关闭 ${documentTitle(tab)}`}
                onClick={() => onClose(tab)}
              >
                <CloseIcon />
              </button>
            </div>
          ))}
        </div>
        <div className="reader-meta">
          <span className="readonly-pill">
            <EyeIcon /> 只读模式
          </span>
        </div>
      </div>

      <section className="reader-stage document-viewer">
        {activeTab === null ? (
          <EmptyDocumentSurface />
        ) : activeTab.error !== null ? (
          <DocumentState message={activeTab.error} error />
        ) : activeTab.content === null ? (
          <DocumentState message="正在读取文档…" />
        ) : (
          <article className="document-surface document-content">
            <div className="document-accent" />
            <pre>{activeTab.content}</pre>
          </article>
        )}
      </section>

      <footer className="reader-footer">
        <span>{activeTab === null ? "未选择文档" : documentLocation(activeTab)}</span>
        <span className="runtime-version">
          <i />
          {runtimeInfo === null
            ? "正在连接桌面运行时…"
            : `Electron ${runtimeInfo.electronVersion} · ${runtimeInfo.platform}`}
        </span>
      </footer>
    </main>
  );
}

function EmptyDocumentSurface(): ReactNode {
  // Render the existing reader guidance while no document tab is active.
  // 1. Preserve the workspace identity and read-only visual surface.
  // 2. Describe the two supported source formats without enabling editing actions.
  return (
    <div className="document-surface">
      <div className="document-accent" />
      <div className="document-empty-icon">
        <OpenBookIcon />
      </div>
      <p className="eyebrow">CLEODOC WORKSPACE</p>
      <h2>打开作品或资料开始阅读</h2>
      <p className="empty-description">
        作品和资料会在同一组标签页中打开，切换左侧导航不会改变当前文档。
      </p>
      <div className="supported-formats">
        <span>
          <MarkdownIcon /> Markdown 阅读
        </span>
        <span>
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
    <div className={`document-surface document-state${error ? " error" : ""}`}>
      <div className="document-accent" />
      <strong>{message}</strong>
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
