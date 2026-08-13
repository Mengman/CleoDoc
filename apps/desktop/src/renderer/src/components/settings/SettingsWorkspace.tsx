import { Settings as SettingsIcon } from "lucide-react";
import type { ReactNode } from "react";

const settingsSections = ["软件配置"] as const;

export function SettingsWorkspace(): ReactNode {
  // Render settings as a full feature workspace with category and content columns.
  // 1. Use the left column for settings categories.
  // 2. Reserve the right column for the selected category without showing reader or chat panels.
  return (
    <div className="settings-workspace">
      <aside className="settings-navigation" aria-label="设置分类">
        <div className="settings-heading">
          <SettingsIcon />
          <h1>设置</h1>
        </div>
        <nav>
          {settingsSections.map((section, index) => (
            <button
              key={section}
              className={
                index === 0 ? "settings-navigation-item active" : "settings-navigation-item"
              }
              type="button"
            >
              {section}
            </button>
          ))}
        </nav>
      </aside>
      <main className="settings-content">
        <p className="eyebrow">CLEODOC SETTINGS</p>
        <h2>软件配置</h2>
        <p>Provider、模型和软件配置将在这里接入现有 Application Service。</p>
      </main>
    </div>
  );
}
