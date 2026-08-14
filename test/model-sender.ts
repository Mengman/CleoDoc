import type {
  ModelCapabilities,
  ModelExecution,
  ModelMessageSender,
  ModelProvider,
} from "../packages/contracts/src/index.js";

export function senderForProvider<T extends ModelProvider>(
  provider: T,
  model = "fake-model",
  capabilities: ModelCapabilities = {
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 384_000,
    reasoningSupported: true,
    reasoningEfforts: ["low", "medium", "high"],
  },
): T & ModelMessageSender {
  // Adapt a concrete fake Provider to the application-facing execution boundary.
  return Object.assign(provider, {
    async createExecution(): Promise<ModelExecution> {
      return {
        providerId: provider.id,
        providerName: provider.displayName,
        model,
        modelName: model,
        parameters: { reasoningEnabled: false },
        capabilities,
        send: (request, signal) =>
          provider.stream({ ...request, model, thinking: { type: "disabled" } }, signal),
      };
    },
  });
}

export class MutableModelMessageSender implements ModelMessageSender {
  private current: ModelMessageSender;

  constructor(provider: ModelProvider, model = "fake-model") {
    this.current = senderForProvider(provider, model);
  }

  use(provider: ModelProvider, model = "fake-model"): void {
    this.current = senderForProvider(provider, model);
  }

  createExecution(): Promise<ModelExecution> {
    return this.current.createExecution();
  }
}
