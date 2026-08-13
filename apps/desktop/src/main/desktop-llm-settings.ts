import {
  getSoftwareConfig,
  saveOpenAiCompatibleSoftwareConfig,
} from "../../../../packages/config/src/index.js";
import { AppError } from "../../../../packages/contracts/src/index.js";
import type {
  DesktopLlmApiSettings,
  SaveDesktopLlmApiSettingsInput,
} from "../shared/desktop-api.js";
import type { DesktopCredentialStore } from "./desktop-credential-store.js";

const desktopModelName = "deepseek-v4-flash" as const;

export class DesktopLlmSettingsService {
  constructor(private readonly credentials: DesktopCredentialStore) {}

  async get(): Promise<DesktopLlmApiSettings> {
    // Return renderer-safe connection settings without exposing the API key.
    const config = getSoftwareConfig();
    const apiKey = await this.credentials.readApiKey();
    return {
      baseUrl: config.llm.providers["openai-compatible"]!.baseUrl,
      modelName: desktopModelName,
      apiKeyConfigured: apiKey !== undefined,
      apiKeyLength: apiKey?.length ?? null,
      secureStorageAvailable: await this.credentials.isAvailable(),
    };
  }

  async save(input: SaveDesktopLlmApiSettingsInput): Promise<DesktopLlmApiSettings> {
    // Persist the temporary DeepSeek connection while keeping its secret outside YAML.
    // 1. Verify secure persistence before changing configuration when a key was supplied.
    // 2. Store the fixed provider, endpoint, and configured catalog model in user YAML.
    // 3. Encrypt the optional replacement key and return only its configured state.
    if (input.apiKey !== undefined && !(await this.credentials.isAvailable())) {
      throw new AppError("CONFIG_ERROR", "当前系统没有可用的安全凭据存储，API Key 未保存。");
    }
    if (input.apiKey !== undefined) await this.credentials.saveApiKey(input.apiKey);
    await saveOpenAiCompatibleSoftwareConfig(input.baseUrl, desktopModelName);
    return this.get();
  }

  readApiKey(): Promise<string | undefined> {
    return this.credentials.readApiKey();
  }
}
