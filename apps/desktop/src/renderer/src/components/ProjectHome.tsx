import { FolderOpen, KeyRound, Plus, Save } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";

import type { DesktopLlmApiSettings } from "../../../shared/desktop-api.js";

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
    <main className="project-home">
      <section className="project-home-content" aria-labelledby="project-home-title">
        <header className="project-home-heading">
          <p className="eyebrow">CLEODOC</p>
          <h1 id="project-home-title">开始使用 CleoDoc</h1>
          <p>本地优先的中文小说 AI 主笔</p>
        </header>

        {showProviderSetup ? (
          <section
            className="project-home-card provider-setup"
            aria-labelledby="provider-setup-title"
          >
            <div className="project-home-card-heading">
              <KeyRound />
              <div>
                <h2 id="provider-setup-title">LLM API 配置</h2>
                <p>选择当前支持的 Provider 并保存 API Key。</p>
              </div>
            </div>
            <form onSubmit={(event) => void saveProvider(event)}>
              <label>
                <span>Provider</span>
                <select value="deepseek" onChange={() => undefined} aria-label="Provider">
                  <option value="deepseek">DeepSeek</option>
                </select>
              </label>
              <label>
                <span>API Key</span>
                <input
                  type="password"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  onFocus={() => {
                    if (apiKey === createSavedApiKeyMask(settings?.apiKeyLength ?? null))
                      setApiKey("");
                  }}
                  placeholder="请输入 DeepSeek API Key"
                  autoComplete="new-password"
                  disabled={settings !== null && !settings.secureStorageAvailable}
                />
              </label>
              <div className="project-home-form-footer">
                <p
                  className={
                    providerStatus.includes("无法") || providerStatus.includes("请输入")
                      ? "error"
                      : ""
                  }
                >
                  {providerStatus}
                </p>
                <button type="submit" disabled={settings === null || saving}>
                  <Save />
                  {saving ? "保存中…" : "保存配置"}
                </button>
              </div>
              {settings !== null && !settings.secureStorageAvailable ? (
                <p className="project-home-warning">当前系统无法安全保存 API Key。</p>
              ) : null}
            </form>
          </section>
        ) : null}

        <section
          className="project-home-card project-actions"
          aria-labelledby="project-actions-title"
        >
          <div className="project-home-card-heading">
            <FolderOpen />
            <div>
              <h2 id="project-actions-title">项目</h2>
              <p>创建新作品，或打开已有的 CleoDoc 项目。</p>
            </div>
          </div>
          <div className="project-action-list">
            <button
              type="button"
              onClick={() => void runProjectAction("create")}
              disabled={openingProject}
            >
              <Plus />
              <span>
                <strong>新建项目</strong>
                <small>从空白目录创建新的作品项目</small>
              </span>
            </button>
            <button
              type="button"
              onClick={() => void runProjectAction("open")}
              disabled={openingProject}
            >
              <FolderOpen />
              <span>
                <strong>打开项目</strong>
                <small>打开本地已有的 CleoDoc 项目</small>
              </span>
            </button>
          </div>
          {projectStatus !== "" ? (
            <p className="project-home-action-error">{projectStatus}</p>
          ) : null}
        </section>
      </section>
    </main>
  );
}
