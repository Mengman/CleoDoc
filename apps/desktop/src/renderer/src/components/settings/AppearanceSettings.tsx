import { useEffect, useState, type ReactNode } from "react";

import type {
  DesktopThemePreference,
  DesktopThemeSettings,
} from "../../../../shared/desktop-api.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select.js";

const themeLabels: Record<DesktopThemePreference, string> = {
  system: "跟随系统",
  light: "浅色",
  dark: "深色",
};

function isThemePreference(value: string): value is DesktopThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

export function AppearanceSettings(): ReactNode {
  // Load and update the application-wide appearance preference through Typed IPC.
  // 1. Read the saved preference without accessing application state from the Renderer.
  // 2. Persist valid selection changes through the existing desktop theme boundary.
  // 3. Keep the last saved value visible when a write fails.
  const [settings, setSettings] = useState<DesktopThemeSettings | null>(null);
  const [status, setStatus] = useState("正在读取外观设置…");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    void window.cleodoc
      .getThemeSettings()
      .then((loaded) => {
        if (!active) return;
        setSettings(loaded);
        setStatus(`当前主题：${themeLabels[loaded.preference]}`);
      })
      .catch(() => {
        if (active) setStatus("无法读取外观设置");
      });
    return () => {
      active = false;
    };
  }, []);

  async function handleThemeChange(value: string): Promise<void> {
    // Save a valid theme selection and retain the previous setting after a failure.
    if (!isThemePreference(value) || saving || settings === null) return;
    setSaving(true);
    try {
      const result = await window.cleodoc.saveThemeSettings(value);
      if (result.outcome === "error") {
        setStatus(result.error.message);
      } else {
        setSettings(result.settings);
        setStatus(`已切换为${themeLabels[result.settings.preference]}`);
      }
    } catch {
      setStatus("无法保存外观设置");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="mt-8 max-w-xl">
      <label className="grid gap-2 text-xs text-foreground">
        <span>主题</span>
        <Select
          value={settings?.preference ?? "system"}
          onValueChange={(value) => void handleThemeChange(value)}
          disabled={settings === null || saving}
        >
          <SelectTrigger className="w-full">
            <SelectValue placeholder="选择主题" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="system">跟随系统</SelectItem>
            <SelectItem value="light">浅色</SelectItem>
            <SelectItem value="dark">深色</SelectItem>
          </SelectContent>
        </Select>
      </label>
      <p className="mt-4 text-xs text-muted-foreground" aria-live="polite">
        {status}
      </p>
    </section>
  );
}
