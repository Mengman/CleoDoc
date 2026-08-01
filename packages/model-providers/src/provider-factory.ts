import type { ModelProvider } from "../../contracts/src/index.js";
import { AppError } from "../../contracts/src/index.js";
import { OllamaProvider } from "./ollama-provider.js";
import { OpenAICompatibleProvider } from "./openai-compatible-provider.js";

export interface ProviderFactoryOptions {
  baseUrl?: string;
  apiKeyEnvironmentVariable?: string;
  environment?: NodeJS.ProcessEnv;
}

export function createProvider(
  providerId: string,
  options: ProviderFactoryOptions = {},
): ModelProvider {
  const environment = options.environment ?? process.env;
  switch (providerId) {
    case "openai-compatible": {
      const variableName = options.apiKeyEnvironmentVariable ?? "OPENAI_API_KEY";
      return new OpenAICompatibleProvider({
        apiKey: environment[variableName],
        baseUrl: options.baseUrl ?? environment.OPENAI_BASE_URL,
      });
    }
    case "ollama":
      return new OllamaProvider({ baseUrl: options.baseUrl ?? environment.OLLAMA_BASE_URL });
    default:
      throw new AppError("VALIDATION_ERROR", `不支持的 Provider：${providerId}`);
  }
}

export const providerCatalog = [
  { id: "openai-compatible", displayName: "OpenAI-compatible", apiKeyEnv: "OPENAI_API_KEY" },
  { id: "ollama", displayName: "Ollama", apiKeyEnv: null },
] as const;
