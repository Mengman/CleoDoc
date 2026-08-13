import { createContextBudgetPolicy } from "../../../../packages/agent/src/index.js";
import { getSoftwareConfig } from "../../../../packages/config/src/index.js";
import { AppError } from "../../../../packages/contracts/src/index.js";
import { createProvider } from "../../../../packages/model-providers/src/index.js";
import type { SendDesktopChatMessageInput } from "../shared/desktop-api.js";
import type { DesktopLlmSettingsService } from "./desktop-llm-settings.js";
import type { DesktopProjectRuntime } from "./desktop-project-runtime.js";

export function createDesktopChatServiceOptions() {
  // Build the project chat runtime from the validated software configuration.
  const config = getSoftwareConfig();
  const providerId = config.llm.selectedProvider ?? "openai-compatible";
  const modelName = config.llm.selectedModel;
  const model =
    modelName === null ? undefined : config.llm.providers[providerId]?.models[modelName];
  return {
    maxToolRounds: config.agent.maxToolRounds,
    ...(model === undefined
      ? {}
      : { defaultContextBudgetPolicy: createContextBudgetPolicy(model, config.context) }),
    compaction: config.agent.compaction,
  };
}

export class DesktopChatService {
  constructor(
    private readonly projects: DesktopProjectRuntime,
    private readonly llmSettings: DesktopLlmSettingsService,
  ) {}

  async send(input: SendDesktopChatMessageInput) {
    // Send a new or continuing message with the currently saved desktop model configuration.
    // 1. Resolve the fixed transitional provider and model from validated software settings.
    // 2. Read the API key only in the main process and construct the provider locally.
    // 3. Run the message inside the active project session and return its latest visible messages.
    const config = getSoftwareConfig();
    const existingTarget =
      input.conversationId === undefined
        ? undefined
        : this.projects.getConversationModel(input.conversationId);
    const providerId =
      existingTarget?.providerId ?? config.llm.selectedProvider ?? "openai-compatible";
    const model = existingTarget?.model ?? config.llm.selectedModel;
    const providerConfig = config.llm.providers[providerId];
    if (providerConfig === undefined || model === null) {
      throw new AppError("CONFIG_ERROR", "请先完成模型 API 配置。");
    }
    const configuredModel = providerConfig.models[model];
    if (configuredModel === undefined) {
      throw new AppError("CONFIG_ERROR", `模型 ${providerId}/${model} 缺少能力配置。`);
    }

    const apiKey = await this.llmSettings.readApiKey();
    if (providerId === "openai-compatible" && apiKey === undefined) {
      throw new AppError("CONFIG_ERROR", "请先在设置中填写并保存 API Key。");
    }
    const provider = createProvider(providerId, {
      baseUrl: providerConfig.baseUrl,
      connectionTimeoutMs: config.llm.timeouts.connectionMs,
      streamIdleTimeoutMs: config.llm.timeouts.streamIdleMs,
      overallTimeoutMs: config.llm.timeouts.overallMs,
      environment: apiKey === undefined ? {} : { CLEODOC_API_KEY: apiKey },
    });
    return this.projects.sendMessage({
      ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
      prompt: input.prompt,
      provider,
      model,
      contextBudgetPolicy: createContextBudgetPolicy(configuredModel, config.context),
    });
  }
}
