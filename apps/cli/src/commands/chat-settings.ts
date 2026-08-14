import { getSoftwareConfig } from "../../../../packages/config/src/index.js";
import { AppError } from "../../../../packages/contracts/src/index.js";
import {
  EnvironmentProviderCredentialStore,
  ProviderService,
} from "../../../../packages/model-providers/src/index.js";
import { optionString, type ParsedArguments } from "../arguments.js";
import { optionPositiveInteger, parsePositiveEnvironmentInteger } from "./command-utils.js";

export function providerServiceFromArguments(
  providerId: string,
  modelId: string,
  parsed: ParsedArguments,
): ProviderService {
  // Create the CLI-facing service with command-scoped endpoint and timeout overrides.
  // 1. Validate the selected Provider against the software catalog.
  // 2. Resolve CLI and environment overrides without changing persisted configuration.
  // 3. Keep credentials and concrete Provider construction behind ProviderService.
  const config = getSoftwareConfig();
  const configuredProvider = config.llm.providers[providerId];
  if (configuredProvider === undefined) {
    throw new AppError("VALIDATION_ERROR", `软件配置中没有 Provider：${providerId}`);
  }
  const environment = process.env;
  const configuredModel = configuredProvider.models[modelId];
  if (configuredModel === undefined) {
    throw new AppError("VALIDATION_ERROR", `Provider ${providerId} has no model: ${modelId}`);
  }
  const contextWindowTokens =
    optionPositiveInteger(parsed, "context-window-tokens") ??
    parsePositiveEnvironmentInteger("CLEODOC_MODEL_CONTEXT_TOKENS") ??
    configuredModel.contextWindowTokens;
  const maxOutputTokens =
    optionPositiveInteger(parsed, "max-output-tokens") ??
    parsePositiveEnvironmentInteger("CLEODOC_MODEL_MAX_OUTPUT_TOKENS") ??
    configuredModel.maxOutputTokens;
  if (contextWindowTokens < 2_048 || maxOutputTokens > contextWindowTokens) {
    throw new AppError("VALIDATION_ERROR", "Invalid model context capability override.");
  }
  return new ProviderService({
    credentials: new EnvironmentProviderCredentialStore(environment),
    environment,
    overrides: {
      providerId,
      modelId,
      baseUrl:
        optionString(parsed, "base-url") ??
        environment.OPENAI_BASE_URL ??
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
      contextWindowTokens,
      maxOutputTokens,
    },
  });
}

export function chatServiceOptions() {
  const config = getSoftwareConfig();
  return {
    database: { busyTimeoutMs: config.database.busyTimeoutMs },
    maxToolRounds: config.agent.maxToolRounds,
    context: config.context,
    compaction: config.agent.compaction,
  };
}
