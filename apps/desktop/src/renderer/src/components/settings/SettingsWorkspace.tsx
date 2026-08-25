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
    <div className="grid size-full min-h-0 min-w-0 grid-cols-[260px_minmax(0,1fr)] bg-background">
      <aside className="border-r border-border bg-surface px-4 py-6" aria-label="设置分类">
        <div className="flex items-center gap-2.5 px-2 pb-5">
          <SettingsIcon className="text-primary" />
          <h1 className="m-0 text-[17px] text-foreground">设置</h1>
        </div>
        <nav className="grid gap-1.5">
          {settingsSections.map((section) => (
            <button
              key={section}
              className={`rounded-lg px-3 py-2.5 text-left text-sm transition-colors ${
                activeSection === section
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground"
              }`}
              type="button"
              onClick={() => setActiveSection(section)}
            >
              {section}
            </button>
          ))}
        </nav>
      </aside>
      <main className="min-w-0 overflow-y-auto bg-background p-12">
        {activeSection === "模型 API" ? (
          <>
            <p className="mb-2.5 text-[10px] font-bold tracking-[0.2em] text-primary">
              CLEODOC SETTINGS
            </p>
            <h2 className="m-0 text-2xl text-foreground">模型 API 配置</h2>
            <LlmApiSettings />
          </>
        ) : (
          <>
            <p className="mb-2.5 text-[10px] font-bold tracking-[0.2em] text-primary">
              CLEODOC SETTINGS
            </p>
            <h2 className="m-0 text-2xl text-foreground">外观</h2>
            <AppearanceSettings />
          </>
        )}
      </main>
    </div>
  );
}
