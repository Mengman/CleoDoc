import { createContextBudgetPolicy } from "../../../../packages/agent/src/index.js";
import { getSoftwareConfig } from "../../../../packages/config/src/index.js";
import { AppError, type ModelEvent } from "../../../../packages/contracts/src/index.js";
import type { ProviderService } from "../../../../packages/model-providers/src/index.js";
import type { SendDesktopChatMessageInput } from "../shared/desktop-api.js";
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
    private readonly providerService: ProviderService,
  ) {}

  async send(input: SendDesktopChatMessageInput, onEvent?: (event: ModelEvent) => void) {
    // Send a new or continuing message with the currently saved desktop model configuration.
    // Resolve the conversation target and send it through the shared ProviderService.
    // 1. Read the immutable Provider and model identity stored with the conversation.
    // 2. Resolve its context budget from validated software configuration.
    // 3. Send through the shared service without exposing credentials or concrete Providers.
    const existingTarget = this.projects.getConversationModel(input.conversationId);
    const providerId = existingTarget.providerId;
    const model = existingTarget.model;
    const config = getSoftwareConfig();
    const providerConfig = config.llm.providers[providerId];
    const configuredModel = providerConfig?.models[model];
    if (configuredModel === undefined) {
      throw new AppError("CONFIG_ERROR", `模型 ${providerId}/${model} 缺少能力配置。`);
    }
    return this.projects.sendMessage({
      conversationId: input.conversationId,
      prompt: input.prompt,
      provider: this.providerService,
      model,
      contextBudgetPolicy: createContextBudgetPolicy(configuredModel, config.context),
      ...(onEvent === undefined ? {} : { onEvent }),
    });
  }
}
