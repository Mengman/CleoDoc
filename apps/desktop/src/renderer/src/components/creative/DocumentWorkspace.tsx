import {
  AlignLeft as TextIcon,
  BookOpen as OpenBookIcon,
  Eye as EyeIcon,
  FileCode2 as MarkdownIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import type { DesktopRuntimeInfo } from "../../../../shared/desktop-api.js";

export interface DocumentWorkspaceProps {
  readonly runtimeInfo: DesktopRuntimeInfo | null;
}

export function DocumentWorkspace({ runtimeInfo }: DocumentWorkspaceProps): ReactNode {
  // Render the document tabs and reader independently from the selected left sidebar.
  // 1. Keep one tab region for both works and materials.
  // 2. Preserve the document surface when the navigation changes its sidebar.
  // 3. Display the common reader footer and desktop runtime status.
  return (
    <main className="reader-panel document-workspace">
      <div className="reader-tabs document-tab-bar">
        <button className="reader-tab active" type="button">
          阅读
        </button>
        <div className="reader-meta">
          <span className="format-pill">Markdown / TXT</span>
          <span className="readonly-pill">
            <EyeIcon /> 只读模式
          </span>
        </div>
      </div>

      <section className="reader-stage document-viewer">
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
      </section>

      <footer className="reader-footer">
        <span>未选择文档</span>
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
