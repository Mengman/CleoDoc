import { KeyRound } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";

import type { DesktopLlmApiSettings } from "../../../../shared/desktop-api.js";
import { Button } from "../ui/button.js";
import { Input } from "../ui/input.js";

function createSavedApiKeyMask(length: number | null): string {
  return "•".repeat(length ?? 0);
}

export function LlmApiSettings(): ReactNode {
  // Load and edit the temporary OpenAI-compatible connection used for DeepSeek debugging.
  // 1. Read renderer-safe settings without requesting the saved API key.
  // 2. Submit endpoint, fixed catalog model, and an optional replacement API key.
  // 3. Report save failures locally and refresh the non-secret configured status.
  const [settings, setSettings] = useState<DesktopLlmApiSettings | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [modelName, setModelName] = useState("deepseek-v4-flash");
  const [status, setStatus] = useState("正在读取配置…");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    void window.cleodoc
      .getLlmApiSettings()
      .then((loaded) => {
        if (!active) return;
        setSettings(loaded);
        setBaseUrl(loaded.baseUrl);
        setModelName(loaded.modelName);
        setApiKey(createSavedApiKeyMask(loaded.apiKeyLength));
        setStatus(loaded.apiKeyConfigured ? "API Key 已安全保存" : "API Key 尚未配置");
      })
      .catch(() => {
        if (active) setStatus("无法读取模型配置");
      });
    return () => {
      active = false;
    };
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    // Validate and save the temporary DeepSeek connection.
    // 1. Reject a missing key or model outside the current packaged catalog.
    // 2. Submit the endpoint, fixed model, and optional replacement secret through typed IPC.
    // 3. Clear secret input on success and always restore the interactive form state.
    event.preventDefault();
    if (settings === null || saving) return;
    const normalizedApiKey = apiKey.trim();
    const savedApiKeyMask = createSavedApiKeyMask(settings.apiKeyLength);
    if (!settings.apiKeyConfigured && normalizedApiKey === "") {
      setStatus("请输入 API Key");
      return;
    }
    if (modelName.trim() !== "deepseek-v4-flash") {
      setStatus("当前仅支持模型 deepseek-v4-flash");
      return;
    }
    setSaving(true);
    setStatus("正在保存…");
    try {
      const result = await window.cleodoc.saveLlmApiSettings({
        baseUrl,
        modelName: "deepseek-v4-flash",
        ...(normalizedApiKey === "" || normalizedApiKey === savedApiKeyMask
          ? {}
          : { apiKey: normalizedApiKey }),
      });
      if (result.outcome === "error") {
        setStatus(result.error.message);
      } else {
        setSettings(result.settings);
        setBaseUrl(result.settings.baseUrl);
        setApiKey(createSavedApiKeyMask(result.settings.apiKeyLength));
        setStatus("配置已保存，API Key 已由操作系统安全保护");
      }
    } catch {
      setStatus("无法保存模型配置");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section
      className="mt-8 max-w-[680px] rounded-[14px] border border-border bg-surface p-6 shadow-md"
      aria-labelledby="llm-api-settings-title"
    >
      <div className="mb-6 flex items-center gap-3">
        <div className="grid size-10 place-items-center rounded-[10px] bg-accent text-accent-foreground">
          <KeyRound />
        </div>
        <div>
          <h3 id="llm-api-settings-title" className="m-0 text-[15px] text-foreground">
            DeepSeek API
          </h3>
          <p className="mb-0 mt-[5px] text-[11px] text-muted-foreground">
            当前通过 OpenAI-compatible 接口用于开发调试。
          </p>
        </div>
      </div>
      <form className="grid gap-[18px]" onSubmit={(event) => void handleSubmit(event)}>
        <label className="grid gap-2 text-[11px] text-foreground">
          <span>Base URL</span>
          <Input
            type="url"
            required
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder="https://api.deepseek.com"
            autoComplete="url"
          />
        </label>
        <label className="grid gap-2 text-[11px] text-foreground">
          <span>API Key</span>
          <Input
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            onFocus={() => {
              if (apiKey === createSavedApiKeyMask(settings?.apiKeyLength ?? null)) setApiKey("");
            }}
            onBlur={() => {
              if (apiKey === "" && settings?.apiKeyConfigured) {
                setApiKey(createSavedApiKeyMask(settings.apiKeyLength));
              }
            }}
            placeholder="请输入 API Key"
            autoComplete="new-password"
            disabled={settings !== null && !settings.secureStorageAvailable}
          />
        </label>
        <label className="grid gap-2 text-[11px] text-foreground">
          <span>Model Name</span>
          <Input
            type="text"
            required
            value={modelName}
            onChange={(event) => setModelName(event.target.value)}
            pattern="deepseek-v4-flash"
          />
        </label>
        <div className="flex items-center justify-between gap-4 pt-1">
          <p
            className={`m-0 text-[10px] ${
              status.includes("无法") || status.includes("请输入") || status.includes("当前仅支持")
                ? "text-destructive"
                : "text-success"
            }`}
          >
            {status}
          </p>
          <Button type="submit" disabled={settings === null || saving}>
            {saving ? "保存中…" : "保存配置"}
          </Button>
        </div>
        {settings !== null && !settings.secureStorageAvailable ? (
          <p className="m-0 text-[10px] text-destructive">
            当前操作系统安全凭据存储不可用，无法保存 API Key。
          </p>
        ) : null}
      </form>
    </section>
  );
}
