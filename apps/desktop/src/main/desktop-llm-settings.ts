import type { ProviderService } from "../../../../packages/model-providers/src/index.js";
import type {
  DesktopLlmApiSettings,
  SaveDesktopLlmApiSettingsInput,
} from "../shared/desktop-api.js";

const desktopModelName = "deepseek-v4-flash" as const;

export class DesktopLlmSettingsService {
  constructor(private readonly providerService: ProviderService) {}

  async get(): Promise<DesktopLlmApiSettings> {
    // Return renderer-safe connection settings without exposing the API key.
    const info = await this.providerService.getCurrentInfo();
    return {
      baseUrl: info.baseUrl,
      modelName: desktopModelName,
      apiKeyConfigured: info.apiKeyConfigured,
      apiKeyLength: info.apiKeyLength,
      secureStorageAvailable: info.credentialPersistenceAvailable,
    };
  }

  async save(input: SaveDesktopLlmApiSettingsInput): Promise<DesktopLlmApiSettings> {
    // Delegate Provider configuration and credential lifecycle to the shared service.
    await this.providerService.updateConfiguration({
      baseUrl: input.baseUrl,
      modelId: input.modelName,
      ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
    });
    return this.get();
  }
}
