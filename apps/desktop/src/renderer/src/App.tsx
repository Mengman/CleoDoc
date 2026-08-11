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
  ShieldCheck as ShieldIcon,
  Sparkles as SparkleIcon,
} from "lucide-react";

import type { DesktopRuntimeInfo } from "../../shared/desktop-api.js";

type SectionId = "works" | "materials" | "search" | "settings";

interface SectionDefinition {
  readonly id: SectionId;
  readonly label: string;
  readonly description: string;
  readonly icon: ReactNode;
}

const sections: readonly SectionDefinition[] = [
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
  {
    id: "settings",
    label: "设置",
    description: "Provider 与软件配置",
    icon: <SettingsIcon />,
  },
];

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
  const [activeSection, setActiveSection] = useState<SectionId>("works");
  const [runtimeInfo, setRuntimeInfo] = useState<DesktopRuntimeInfo | null>(null);
  const currentSection = sections.find((section) => section.id === activeSection) ?? sections[0]!;
  const copy = emptyCopy[activeSection];

  useEffect(() => {
    let active = true;
    void window.cleodoc.getRuntimeInfo().then((info) => {
      if (active) setRuntimeInfo(info);
    });
    return () => {
      active = false;
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
            {windowMenus.map((menu) => (
              <button
                key={menu.id}
                type="button"
                onClick={(event) => {
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
            ))}
          </nav>
          <div className="window-title">CleoDoc</div>
        </div>
      </div>

      <header className="topbar">
        <div className="brand-block">
          <div className="brand-mark" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <div>
            <strong>CleoDoc</strong>
            <small>本地优先的中文小说 AI 主笔</small>
          </div>
        </div>

        <div className="current-document">
          <span>当前项目</span>
          <strong>尚未打开项目</strong>
        </div>

        <div className="topbar-actions">
          <div className="status-pill">
            <i /> 桌面界面已就绪
          </div>
          <button className="model-button" type="button" disabled>
            <span>模型</span>
            <strong>待配置</strong>
            <ChevronIcon />
          </button>
          <button className="primary-button" type="button" disabled>
            <PlusIcon /> 新建对话
          </button>
        </div>
      </header>

      <nav className="rail" aria-label="主导航">
        <div className="rail-items">
          {sections.map((section) => (
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
          ))}
        </div>
        <div className="local-indicator" title="项目数据保存在本地">
          <ShieldIcon />
          <span>本地</span>
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
            <strong>未打开</strong>
          </div>
          <ChevronIcon />
        </div>

        <div className="list-heading">
          <span>{currentSection.label === "works" ? "作品目录" : currentSection.label}</span>
          <small>0 项</small>
        </div>

        <div className="panel-empty">
          <div className="empty-mini-icon">{currentSection.icon}</div>
          <strong>暂无内容</strong>
          <span>项目打开后将在这里显示</span>
        </div>

        <div className="panel-footer">
          <ShieldIcon />
          <div>
            <strong>项目数据仅保存在本地</strong>
            <span>未打开任何项目</span>
          </div>
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
        <div className="chat-heading">
          <div>
            <h2>主笔对话</h2>
            <p>理解作品上下文，协助推进创作</p>
          </div>
          <span className="agent-status">
            <i /> 等待项目
          </span>
        </div>

        <div className="context-row">
          <span className="context-chip active">当前项目</span>
          <span className="context-chip">Conversation</span>
          <span className="context-chip">上下文</span>
        </div>

        <div className="conversation-empty">
          <div className="assistant-avatar">C</div>
          <div>
            <strong>Cleo · 主笔 Agent</strong>
            <span>本地工作区已准备好</span>
          </div>
          <div className="welcome-card">
            <SparkleIcon />
            <h3>欢迎来到 CleoDoc</h3>
            <p>打开项目后，你可以在这里与主笔对话、检索资料，并审批文档写入。</p>
          </div>
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
