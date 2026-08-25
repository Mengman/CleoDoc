import { FolderOpen, KeyRound, Plus, Save } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";

import type { DesktopLlmApiSettings } from "../../../shared/desktop-api.js";
import { Button } from "./ui/button.js";
import { Input } from "./ui/input.js";

function createSavedApiKeyMask(length: number | null): string {
  return "•".repeat(length ?? 0);
}

export function ProjectHome(): ReactNode {
  // Render the no-project start page and preserve its provider section for this visit.
  // 1. Read the non-secret Provider state once to decide whether initial API setup is needed.
  // 2. Save only the DeepSeek API key through the existing typed settings boundary.
  // 3. Start the existing native project creation and opening flows from the project actions.
  const [settings, setSettings] = useState<DesktopLlmApiSettings | null>(null);
  const [showProviderSetup, setShowProviderSetup] = useState<boolean | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [providerStatus, setProviderStatus] = useState("正在读取 Provider 配置…");
  const [projectStatus, setProjectStatus] = useState("");
  const [saving, setSaving] = useState(false);
  const [openingProject, setOpeningProject] = useState(false);

  useEffect(() => {
    let active = true;
    void window.cleodoc
      .getLlmApiSettings()
      .then((loaded) => {
        if (!active) return;
        setSettings(loaded);
        setShowProviderSetup(!loaded.apiKeyConfigured);
        setApiKey(createSavedApiKeyMask(loaded.apiKeyLength));
        setProviderStatus(loaded.apiKeyConfigured ? "DeepSeek 已配置" : "请填写 DeepSeek API Key");
      })
      .catch(() => {
        if (!active) return;
        setShowProviderSetup(false);
        setProviderStatus("无法读取 Provider 配置");
      });
    return () => {
      active = false;
    };
  }, []);

  async function saveProvider(event: FormEvent<HTMLFormElement>): Promise<void> {
    // Save the first DeepSeek credential without exposing endpoint or model implementation details.
    // 1. Reject an empty replacement key before invoking the desktop boundary.
    // 2. Send the fixed internal DeepSeek connection values with the secret.
    // 3. Refresh only the renderer-safe configured state after the save completes.
    event.preventDefault();
    if (settings === null || saving) return;
    const key = apiKey.trim();
    if (key === "" || key === createSavedApiKeyMask(settings.apiKeyLength)) {
      setProviderStatus("请输入 API Key");
      return;
    }
    setSaving(true);
    setProviderStatus("正在保存…");
    try {
      const result = await window.cleodoc.saveLlmApiSettings({
        baseUrl: settings.baseUrl,
        modelName: settings.modelName,
        apiKey: key,
      });
      if (result.outcome === "error") {
        setProviderStatus(result.error.message);
      } else {
        setSettings(result.settings);
        setApiKey(createSavedApiKeyMask(result.settings.apiKeyLength));
        setProviderStatus("DeepSeek API Key 已安全保存");
      }
    } catch {
      setProviderStatus("无法保存 Provider 配置");
    } finally {
      setSaving(false);
    }
  }

  async function runProjectAction(action: "create" | "open"): Promise<void> {
    // Run one native project action and keep a safe failure message on the start page.
    if (openingProject) return;
    setOpeningProject(true);
    setProjectStatus("");
    try {
      const result =
        action === "create"
          ? await window.cleodoc.chooseAndCreateProject()
          : await window.cleodoc.chooseAndOpenProject();
      if (result.outcome === "error") setProjectStatus(result.error.message);
    } catch {
      setProjectStatus(action === "create" ? "无法新建项目" : "无法打开项目");
    } finally {
      setOpeningProject(false);
    }
  }

  return (
    <main className="grid h-full min-h-0 min-w-0 overflow-y-auto bg-[radial-gradient(circle_at_50%_0%,var(--surface-raised)_0%,var(--background)_48%)] px-7 py-14 max-[840px]:px-5 max-[840px]:py-8">
      <section className="m-auto w-full max-w-[780px]" aria-labelledby="project-home-title">
        <header className="mb-[30px] text-center">
          <p className="mb-2.5 text-[10px] font-bold tracking-[0.2em] text-primary">CLEODOC</p>
          <h1 id="project-home-title" className="m-0 text-4xl tracking-tight text-foreground">
            开始使用 CleoDoc
          </h1>
          <p className="mt-3 text-[13px] text-muted-foreground">本地优先的中文小说 AI 主笔</p>
        </header>

        {showProviderSetup ? (
          <section
            className="mt-4 rounded-[14px] border border-border bg-surface p-6 shadow-md"
            aria-labelledby="provider-setup-title"
          >
            <div className="mb-[22px] flex items-center gap-3">
              <KeyRound className="size-[22px] text-primary" />
              <div>
                <h2 id="provider-setup-title" className="m-0 text-base text-foreground">
                  LLM API 配置
                </h2>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  选择当前支持的 Provider 并保存 API Key。
                </p>
              </div>
            </div>
            <form className="grid gap-4" onSubmit={(event) => void saveProvider(event)}>
              <label className="grid gap-[7px] text-[11px] text-foreground">
                <span>Provider</span>
                <select
                  className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  value="deepseek"
                  onChange={() => undefined}
                  aria-label="Provider"
                >
                  <option value="deepseek">DeepSeek</option>
                </select>
              </label>
              <label className="grid gap-[7px] text-[11px] text-foreground">
                <span>API Key</span>
                <Input
                  type="password"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  onFocus={() => {
                    if (apiKey === createSavedApiKeyMask(settings?.apiKeyLength ?? null)) {
                      setApiKey("");
                    }
                  }}
                  placeholder="请输入 DeepSeek API Key"
                  autoComplete="new-password"
                  disabled={settings !== null && !settings.secureStorageAvailable}
                />
              </label>
              <div className="flex items-center justify-between gap-4 pt-1">
                <p
                  className={`m-0 text-[10px] ${
                    providerStatus.includes("无法") || providerStatus.includes("请输入")
                      ? "text-destructive"
                      : "text-success"
                  }`}
                >
                  {providerStatus}
                </p>
                <Button type="submit" size="sm" disabled={settings === null || saving}>
                  <Save />
                  {saving ? "保存中…" : "保存配置"}
                </Button>
              </div>
              {settings !== null && !settings.secureStorageAvailable ? (
                <p className="m-0 text-[10px] text-destructive">当前系统无法安全保存 API Key。</p>
              ) : null}
            </form>
          </section>
        ) : null}

        <section
          className="mt-4 rounded-[14px] border border-border bg-surface p-6 shadow-md"
          aria-labelledby="project-actions-title"
        >
          <div className="mb-[22px] flex items-center gap-3">
            <FolderOpen className="size-[22px] text-primary" />
            <div>
              <h2 id="project-actions-title" className="m-0 text-base text-foreground">
                项目
              </h2>
              <p className="mt-1 text-[11px] text-muted-foreground">
                创建新作品，或打开已有的 CleoDoc 项目。
              </p>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3.5 max-[840px]:grid-cols-1">
            <Button
              variant="outline"
              className="h-[100px] justify-start gap-3.5 px-[18px] py-[18px] text-left text-foreground hover:border-primary hover:bg-accent"
              type="button"
              onClick={() => void runProjectAction("create")}
              disabled={openingProject}
            >
              <Plus className="size-7 text-primary" />
              <span className="grid gap-[5px]">
                <strong className="text-sm">新建项目</strong>
                <small className="text-[10px] leading-normal text-muted-foreground">
                  从空白目录创建新的作品项目
                </small>
              </span>
            </Button>
            <Button
              variant="outline"
              className="h-[100px] justify-start gap-3.5 px-[18px] py-[18px] text-left text-foreground hover:border-primary hover:bg-accent"
              type="button"
              onClick={() => void runProjectAction("open")}
              disabled={openingProject}
            >
              <FolderOpen className="size-7 text-primary" />
              <span className="grid gap-[5px]">
                <strong className="text-sm">打开项目</strong>
                <small className="text-[10px] leading-normal text-muted-foreground">
                  打开本地已有的 CleoDoc 项目
                </small>
              </span>
            </Button>
          </div>
          {projectStatus !== "" ? (
            <p className="mt-3.5 text-[10px] text-destructive">{projectStatus}</p>
          ) : null}
        </section>
      </section>
    </main>
  );
}
