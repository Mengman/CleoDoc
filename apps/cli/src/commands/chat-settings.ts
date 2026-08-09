import { createContextBudgetPolicy } from "../../../../packages/agent/src/index.js";
import { getSoftwareConfig } from "../../../../packages/config/src/index.js";
import {
  AppError,
  type ContextBudgetPolicy,
  type ModelProvider,
} from "../../../../packages/contracts/src/index.js";
import { createProvider } from "../../../../packages/model-providers/src/index.js";
import { optionString, type ParsedArguments } from "../arguments.js";
import { optionPositiveInteger, parsePositiveEnvironmentInteger } from "./command-utils.js";

export function providerFromArguments(providerId: string, parsed: ParsedArguments): ModelProvider {
  const config = getSoftwareConfig();
  const configuredProvider = config.llm.providers[providerId];
  if (configuredProvider === undefined) {
    throw new AppError("VALIDATION_ERROR", `软件配置中没有 Provider：${providerId}`);
  }
  return createProvider(providerId, {
    baseUrl:
      optionString(parsed, "base-url") ??
      (providerId === "ollama" ? process.env.OLLAMA_BASE_URL : process.env.OPENAI_BASE_URL) ??
      configuredProvider.baseUrl,
    connectionTimeoutMs:
      optionPositiveInteger(parsed, "connect-timeout-ms") ??
      parsePositiveEnvironmentInteger("CLEODOC_LLM_CONNECT_TIMEOUT_MS") ??
      config.llm.timeouts.connectionMs,
    streamIdleTimeoutMs:
      optionPositiveInteger(parsed, "stream-idle-timeout-ms") ??
      parsePositiveEnvironmentInteger("CLEODOC_LLM_STREAM_IDLE_TIMEOUT_MS") ??
      config.llm.timeouts.streamIdleMs,
    overallTimeoutMs:
      optionPositiveInteger(parsed, "generation-timeout-ms") ??
      parsePositiveEnvironmentInteger("CLEODOC_LLM_OVERALL_TIMEOUT_MS") ??
      config.llm.timeouts.overallMs,
  });
}

export function resolveContextBudgetPolicy(
  providerId: string,
  model: string,
  parsed: ParsedArguments,
): ContextBudgetPolicy {
  const config = getSoftwareConfig();
  const configured = config.llm.providers[providerId]?.models[model];
  const contextWindowTokens =
    optionPositiveInteger(parsed, "context-window-tokens") ??
    parsePositiveEnvironmentInteger("CLEODOC_MODEL_CONTEXT_TOKENS") ??
    configured?.contextWindowTokens;
  const maxOutputTokens =
    optionPositiveInteger(parsed, "max-output-tokens") ??
    parsePositiveEnvironmentInteger("CLEODOC_MODEL_MAX_OUTPUT_TOKENS") ??
    configured?.maxOutputTokens;
  if (contextWindowTokens === undefined || maxOutputTokens === undefined) {
    throw new AppError(
      "VALIDATION_ERROR",
      `模型 ${providerId}/${model} 尚无能力配置。请补充软件默认配置，或临时使用 --context-window-tokens 和 --max-output-tokens。`,
    );
  }
  if (contextWindowTokens < 2_048) {
    throw new AppError("VALIDATION_ERROR", "模型上下文窗口不能小于 2048 Token。");
  }
  if (maxOutputTokens > contextWindowTokens) {
    throw new AppError("VALIDATION_ERROR", "模型最大输出长度不能超过上下文窗口长度。");
  }
  return createContextBudgetPolicy({ contextWindowTokens, maxOutputTokens }, config.context);
}

export function chatServiceOptions() {
  const config = getSoftwareConfig();
  const selectedProvider = config.llm.selectedProvider ?? "openai-compatible";
  const selectedModel = config.llm.selectedModel;
  const configuredModel =
    selectedModel === null
      ? undefined
      : config.llm.providers[selectedProvider]?.models[selectedModel];
  return {
    database: { busyTimeoutMs: config.database.busyTimeoutMs },
    maxToolRounds: config.agent.maxToolRounds,
    ...(configuredModel === undefined
      ? {}
      : {
          defaultContextBudgetPolicy: createContextBudgetPolicy(configuredModel, config.context),
        }),
    compaction: config.agent.compaction,
  };
}
