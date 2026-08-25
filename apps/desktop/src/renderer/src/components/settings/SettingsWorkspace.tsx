import { Settings as SettingsIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { AppearanceSettings } from "./AppearanceSettings.js";
import { LlmApiSettings } from "./LlmApiSettings.js";

const settingsSections = ["模型 API", "外观"] as const;
type SettingsSection = (typeof settingsSections)[number];

export function SettingsWorkspace(): ReactNode {
  // Render settings as a full feature workspace with category and content columns.
  // 1. Keep the selected settings category local to the settings workspace.
  // 2. Render only the matching existing settings content in the right column.
  // 3. Preserve the surrounding document workspace while settings is visible.
  const [activeSection, setActiveSection] = useState<SettingsSection>("模型 API");
  return (
    <div className="settings-workspace">
      <aside className="settings-navigation" aria-label="设置分类">
        <div className="settings-heading">
          <SettingsIcon />
          <h1>设置</h1>
        </div>
        <nav>
          {settingsSections.map((section) => (
            <button
              key={section}
              className={
                activeSection === section
                  ? "settings-navigation-item active"
                  : "settings-navigation-item"
              }
              type="button"
              onClick={() => setActiveSection(section)}
            >
              {section}
            </button>
          ))}
        </nav>
      </aside>
      <main className="settings-content">
        {activeSection === "模型 API" ? (
          <>
            <p className="eyebrow">CLEODOC SETTINGS</p>
            <h2>模型 API 配置</h2>
            <LlmApiSettings />
          </>
        ) : (
          <>
            <p className="eyebrow">CLEODOC SETTINGS</p>
            <h2>外观</h2>
            <AppearanceSettings />
          </>
        )}
      </main>
    </div>
  );
}
