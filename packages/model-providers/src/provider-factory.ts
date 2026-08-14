import type { ModelProvider } from "../../contracts/src/index.js";
import { AppError } from "../../contracts/src/index.js";
import { OpenAICompatibleProvider } from "./openai-compatible-provider.js";

export interface ProviderFactoryOptions {
  baseUrl: string;
  connectionTimeoutMs: number;
  streamIdleTimeoutMs: number;
  overallTimeoutMs: number;
  environment?: NodeJS.ProcessEnv;
}

export function createProvider(providerId: string, options: ProviderFactoryOptions): ModelProvider {
  // Create the concrete adapter for a currently supported Provider identifier.
  const environment = options.environment ?? process.env;
  const timeoutOptions = {
    connectionTimeoutMs: options.connectionTimeoutMs,
    streamIdleTimeoutMs: options.streamIdleTimeoutMs,
    overallTimeoutMs: options.overallTimeoutMs,
  };
  if (providerId !== "openai-compatible") {
    throw new AppError("VALIDATION_ERROR", `不支持的 Provider：${providerId}`);
  }
  return new OpenAICompatibleProvider({
    apiKey: environment.CLEODOC_API_KEY,
    baseUrl: options.baseUrl,
    ...timeoutOptions,
  });
}

export const providerCatalog = [
  { id: "openai-compatible", displayName: "OpenAI-compatible", requiresApiKey: true },
] as const;
