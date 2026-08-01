import type { ModelProvider } from "../../contracts/src/index.js";
import { AppError } from "../../contracts/src/index.js";
import { OllamaProvider } from "./ollama-provider.js";
import { OpenAICompatibleProvider } from "./openai-compatible-provider.js";

export interface ProviderFactoryOptions {
  baseUrl?: string;
  apiKeyEnvironmentVariable?: string;
  connectionTimeoutMs?: number;
  streamIdleTimeoutMs?: number;
  overallTimeoutMs?: number;
  environment?: NodeJS.ProcessEnv;
}

export function createProvider(
  providerId: string,
  options: ProviderFactoryOptions = {},
): ModelProvider {
  const environment = options.environment ?? process.env;
  const timeoutOptions = {
    connectionTimeoutMs:
      options.connectionTimeoutMs ??
      timeoutFromEnvironment(environment, "CLEODOC_LLM_CONNECT_TIMEOUT_MS"),
    streamIdleTimeoutMs:
      options.streamIdleTimeoutMs ??
      timeoutFromEnvironment(environment, "CLEODOC_LLM_STREAM_IDLE_TIMEOUT_MS"),
    overallTimeoutMs:
      options.overallTimeoutMs ??
      timeoutFromEnvironment(environment, "CLEODOC_LLM_OVERALL_TIMEOUT_MS"),
  };
  switch (providerId) {
    case "openai-compatible": {
      const variableName = options.apiKeyEnvironmentVariable ?? "OPENAI_API_KEY";
      return new OpenAICompatibleProvider({
        apiKey: environment[variableName],
        baseUrl: options.baseUrl ?? environment.OPENAI_BASE_URL,
        ...definedTimeoutOptions(timeoutOptions),
      });
    }
    case "ollama":
      return new OllamaProvider({
        baseUrl: options.baseUrl ?? environment.OLLAMA_BASE_URL,
        ...definedTimeoutOptions(timeoutOptions),
      });
    default:
      throw new AppError("VALIDATION_ERROR", `不支持的 Provider：${providerId}`);
  }
}

export const providerCatalog = [
  { id: "openai-compatible", displayName: "OpenAI-compatible", apiKeyEnv: "OPENAI_API_KEY" },
  { id: "ollama", displayName: "Ollama", apiKeyEnv: null },
] as const;

function timeoutFromEnvironment(
  environment: NodeJS.ProcessEnv,
  variableName: string,
): number | undefined {
  const value = environment[variableName];
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  return parsePositiveTimeout(value, variableName);
}

function parsePositiveTimeout(value: string, label: string): number {
  if (!/^\d+$/.test(value)) {
    throw new AppError("VALIDATION_ERROR", `${label} 必须是正整数毫秒数。`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new AppError("VALIDATION_ERROR", `${label} 必须是正整数毫秒数。`);
  }
  return parsed;
}

function definedTimeoutOptions(options: {
  connectionTimeoutMs: number | undefined;
  streamIdleTimeoutMs: number | undefined;
  overallTimeoutMs: number | undefined;
}): Pick<
  ProviderFactoryOptions,
  "connectionTimeoutMs" | "streamIdleTimeoutMs" | "overallTimeoutMs"
> {
  return {
    ...(options.connectionTimeoutMs === undefined
      ? {}
      : { connectionTimeoutMs: options.connectionTimeoutMs }),
    ...(options.streamIdleTimeoutMs === undefined
      ? {}
      : { streamIdleTimeoutMs: options.streamIdleTimeoutMs }),
    ...(options.overallTimeoutMs === undefined
      ? {}
      : { overallTimeoutMs: options.overallTimeoutMs }),
  };
}
