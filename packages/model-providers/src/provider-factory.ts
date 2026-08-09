import type { ModelProvider } from "../../contracts/src/index.js";
import { AppError } from "../../contracts/src/index.js";
import { OllamaProvider } from "./ollama-provider.js";
import { OpenAICompatibleProvider } from "./openai-compatible-provider.js";

export interface ProviderFactoryOptions {
  baseUrl: string;
  connectionTimeoutMs: number;
  streamIdleTimeoutMs: number;
  overallTimeoutMs: number;
  environment?: NodeJS.ProcessEnv;
}

export function createProvider(providerId: string, options: ProviderFactoryOptions): ModelProvider {
  const environment = options.environment ?? process.env;
  const timeoutOptions = {
    connectionTimeoutMs: options.connectionTimeoutMs,
    streamIdleTimeoutMs: options.streamIdleTimeoutMs,
    overallTimeoutMs: options.overallTimeoutMs,
  };
  switch (providerId) {
    case "openai-compatible": {
      return new OpenAICompatibleProvider({
        apiKey: environment.CLEODOC_API_KEY,
        baseUrl: options.baseUrl,
        ...timeoutOptions,
      });
    }
    case "ollama":
      return new OllamaProvider({
        baseUrl: options.baseUrl,
        ...timeoutOptions,
      });
    default:
      throw new AppError("VALIDATION_ERROR", `不支持的 Provider：${providerId}`);
  }
}

export const providerCatalog = [
  { id: "openai-compatible", displayName: "OpenAI-compatible", requiresApiKey: true },
  { id: "ollama", displayName: "Ollama", requiresApiKey: false },
] as const;
