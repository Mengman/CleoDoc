import { useEffect, useState, type ReactNode } from "react";
import {
  AlignLeft as TextIcon,
  Archive as ArchiveIcon,
  ArrowRight as ArrowIcon,
  BookOpen as OpenBookIcon,
  ChevronDown as ChevronIcon,
  Eye as EyeIcon,
  FileCode2 as MarkdownIcon,
  FileText as DocumentIcon,
  Plus as PlusIcon,
  Search as SearchIcon,
  Settings as SettingsIcon,
  Sparkles as SparkleIcon,
} from "lucide-react";

import type { DesktopProjectState, DesktopRuntimeInfo } from "../../shared/desktop-api.js";

type SectionId = "works" | "materials" | "search" | "settings";

interface SectionDefinition {
  readonly id: SectionId;
  readonly label: string;
  readonly description: string;
  readonly icon: ReactNode;
}

const mainSections: readonly SectionDefinition[] = [
  {
    id: "works",
    label: "作品",
    description: "管理作品结构与文档",
    icon: <DocumentIcon />,
  },
  {
    id: "materials",
    label: "资料",
    description: "查看项目创作资料",
    icon: <ArchiveIcon />,
  },
  {
    id: "search",
    label: "查询",
    description: "全文与语义检索",
    icon: <SearchIcon />,
  },
];

const settingsSection: SectionDefinition = {
  id: "settings",
  label: "设置",
  description: "Provider 与软件配置",
  icon: <SettingsIcon />,
};

const sections: readonly SectionDefinition[] = [...mainSections, settingsSection];

const windowMenus = [
  { id: "file", label: "File" },
  { id: "edit", label: "Edit" },
  { id: "view", label: "View" },
  { id: "window", label: "Window" },
] as const;

const emptyCopy: Record<SectionId, { title: string; body: string }> = {
  works: {
    title: "打开一部作品开始创作",
    body: "CleoDoc 会在这里展示项目中的 Markdown 和纯文本作品。",
  },
  materials: {
    title: "资料中心尚未打开",
    body: "打开项目后，可以在这里查看和管理 Markdown、TXT 创作资料。",
  },
  search: {
    title: "在本地知识中查询",
    body: "打开项目并建立索引后，可以使用全文、语义和混合检索。",
  },
  settings: {
    title: "配置你的主笔模型",
    body: "后续将在这里连接 OpenAI-compatible 或 Ollama，并管理现有软件配置。",
  },
};

export function App(): ReactNode {
  // Render the current CleoDoc workspace and synchronize it with desktop process state.
  // 1. Maintain local navigation, runtime information, and the public project-state snapshot.
  // 2. Subscribe to project changes and load initial desktop state through the preload API.
  // 3. Render the existing navigation, library, reader, and conversation workspace regions.
  const [activeSection, setActiveSection] = useState<SectionId>("works");
  const [runtimeInfo, setRuntimeInfo] = useState<DesktopRuntimeInfo | null>(null);
  const [projectState, setProjectState] = useState<DesktopProjectState>({ status: "closed" });
  const currentSection = sections.find((section) => section.id === activeSection) ?? sections[0]!;
  const copy = emptyCopy[activeSection];

  useEffect(() => {
    // Load the initial desktop state and keep the project snapshot synchronized until unmount.
    let active = true;
    const stopListening = window.cleodoc.onProjectStateChanged((state) => {
      if (active) setProjectState(state);
    });
    void Promise.all([window.cleodoc.getRuntimeInfo(), window.cleodoc.getProjectState()]).then(
      ([info, state]) => {
        if (!active) return;
        setRuntimeInfo(info);
        setProjectState(state);
      },
    );
    return () => {
      active = false;
      stopListening();
    };
  }, []);

  return (
    <div className="app-shell">
      <div className="window-titlebar">
        <div className="window-titlebar-safe">
          <div className="window-app-mark" aria-label="CleoDoc">
            <span />
            <span />
            <span />
          </div>
          <nav className="window-menu" aria-label="应用菜单">
            {windowMenus.map((menu) => {
              // Render a title-bar menu that anchors its native popup below the clicked button.
              return (
                <button
                  key={menu.id}
                  type="button"
                  onClick={(event) => {
                    // Measure the clicked menu button and request its native popup at that position.
                    const bounds = event.currentTarget.getBoundingClientRect();
                    void window.cleodoc.showWindowMenu({
                      menuId: menu.id,
                      x: Math.round(bounds.left),
                      y: Math.round(bounds.bottom),
                    });
                  }}
                >
                  {menu.label}
                </button>
              );
            })}
          </nav>
          <div className="window-title">CleoDoc</div>
        </div>
      </div>

      <nav className="rail" aria-label="主导航">
        <div className="rail-items">
          {mainSections.map((section) => {
            // Render a navigation item that selects its corresponding workspace section.
            return (
              <button
                key={section.id}
                className={activeSection === section.id ? "rail-item active" : "rail-item"}
                type="button"
                onClick={() => setActiveSection(section.id)}
                aria-current={activeSection === section.id ? "page" : undefined}
              >
                {section.icon}
                <span>{section.label}</span>
              </button>
            );
          })}
        </div>
        <div className="rail-items rail-bottom">
          <button
            className={activeSection === settingsSection.id ? "rail-item active" : "rail-item"}
            type="button"
            onClick={() => setActiveSection(settingsSection.id)}
            aria-current={activeSection === settingsSection.id ? "page" : undefined}
          >
            {settingsSection.icon}
            <span>{settingsSection.label}</span>
          </button>
        </div>
      </nav>

      <aside className="library-panel">
        <div className="panel-heading">
          <div>
            <h1>{currentSection.label}区</h1>
            <p>{currentSection.description}</p>
          </div>
          <button className="square-button" type="button" disabled aria-label="添加">
            <PlusIcon />
          </button>
        </div>

        <label className="search-box">
          <SearchIcon />
          <input
            type="search"
            disabled
            placeholder={`搜索${currentSection.label}…`}
            aria-label={`搜索${currentSection.label}`}
          />
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
          <span>{currentSection.label === "works" ? "作品目录" : currentSection.label}</span>
          <small>
            {projectState.status === "open" && activeSection === "works"
              ? projectState.project.documentCount
              : 0}{" "}
            项
          </small>
        </div>

        <div className="panel-empty">
          <div className="empty-mini-icon">{currentSection.icon}</div>
          <strong>暂无内容</strong>
          <span>项目打开后将在这里显示</span>
        </div>
      </aside>

      <main className="reader-panel">
        <div className="reader-tabs">
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

        <section className="reader-stage">
          <div className="document-surface">
            <div className="document-accent" />
            <div className="document-empty-icon">
              <OpenBookIcon />
            </div>
            <p className="eyebrow">CLEODOC WORKSPACE</p>
            <h2>{copy.title}</h2>
            <p className="empty-description">{copy.body}</p>
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
    </div>
  );
}
