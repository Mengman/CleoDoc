import {
  getSoftwareConfig,
  saveCurrentModelParameters,
  saveCurrentModelSelection,
  saveOpenAiCompatibleSoftwareConfig,
  type SoftwareConfig,
} from "../../config/src/index.js";
import type {
  ModelCapabilities,
  ModelEvent,
  ModelExecution,
  ModelMessageSender,
  ModelParameters,
  ModelProvider,
  ModelRequest,
  ProviderHealth,
} from "../../contracts/src/index.js";
import { AppError } from "../../contracts/src/index.js";
import { createProvider, type ProviderFactoryOptions } from "./provider-factory.js";

export interface ProviderCredentialStore {
  readonly isPersistenceAvailable: () => Promise<boolean>;
  readonly readApiKey: (providerId: string) => Promise<string | undefined>;
  readonly saveApiKey: (providerId: string, apiKey: string) => Promise<void>;
}

export interface ProviderConfigurationStore {
  readonly get: () => SoftwareConfig;
  readonly updateOpenAiCompatible: (baseUrl: string, modelId: string) => Promise<void>;
  readonly updateSelection: (providerId: string, modelId: string) => Promise<void>;
  readonly updateModelParameters: (parameters: ModelParameters) => Promise<void>;
}

export interface ProviderServiceOverrides {
  readonly providerId?: string;
  readonly modelId?: string;
  readonly baseUrl?: string;
  readonly connectionTimeoutMs?: number;
  readonly streamIdleTimeoutMs?: number;
  readonly overallTimeoutMs?: number;
  readonly contextWindowTokens?: number;
  readonly maxOutputTokens?: number;
}

export interface ProviderServiceOptions {
  readonly credentials: ProviderCredentialStore;
  readonly configuration?: ProviderConfigurationStore;
  readonly overrides?: ProviderServiceOverrides;
  readonly environment?: NodeJS.ProcessEnv;
  readonly providerFactory?: (providerId: string, options: ProviderFactoryOptions) => ModelProvider;
}

export interface ProviderInfo {
  readonly providerId: string;
  readonly providerName: string;
  readonly modelId: string;
  readonly modelName: string;
  readonly baseUrl: string;
  readonly apiKeyConfigured: boolean;
  readonly apiKeyLength: number | null;
  readonly credentialPersistenceAvailable: boolean;
  readonly parameters: ModelParameters;
  readonly capabilities: ModelCapabilities;
}

export interface UpdateProviderConfigurationInput {
  readonly baseUrl: string;
  readonly modelId: string;
  readonly apiKey?: string;
}

interface ResolvedProviderConfiguration {
  readonly providerId: string;
  readonly providerName: string;
  readonly modelId: string;
  readonly modelName: string;
  readonly baseUrl: string;
  readonly requiresApiKey: boolean;
  readonly parameters: ModelParameters;
  readonly capabilities: ModelCapabilities;
  readonly factoryOptions: Omit<ProviderFactoryOptions, "environment">;
}

interface CachedProvider {
  readonly identity: string;
  readonly provider: ModelProvider;
}

const defaultConfiguration: ProviderConfigurationStore = {
  get: getSoftwareConfig,
  updateOpenAiCompatible: async (baseUrl, modelId) => {
    await saveOpenAiCompatibleSoftwareConfig(baseUrl, modelId);
  },
  updateSelection: async (providerId, modelId) => {
    await saveCurrentModelSelection(providerId, modelId);
  },
  updateModelParameters: async (parameters) => {
    await saveCurrentModelParameters(parameters);
  },
};

export class ProviderService implements ModelMessageSender {
  private readonly configuration: ProviderConfigurationStore;
  private readonly providerFactory: NonNullable<ProviderServiceOptions["providerFactory"]>;
  private cachedProvider: CachedProvider | undefined;
  private pendingProvider: Promise<CachedProvider> | undefined;
  private cacheRevision = 0;

  constructor(private readonly options: ProviderServiceOptions) {
    this.configuration = options.configuration ?? defaultConfiguration;
    this.providerFactory = options.providerFactory ?? createProvider;
  }

  async getCurrentInfo(): Promise<ProviderInfo> {
    // Return the current selection, capabilities, and credential status without the secret.
    const resolved = this.resolveConfiguration();
    const apiKey = resolved.requiresApiKey
      ? await this.options.credentials.readApiKey(resolved.providerId)
      : undefined;
    return {
      providerId: resolved.providerId,
      providerName: resolved.providerName,
      modelId: resolved.modelId,
      modelName: resolved.modelName,
      baseUrl: resolved.baseUrl,
      apiKeyConfigured: !resolved.requiresApiKey || apiKey !== undefined,
      apiKeyLength: apiKey?.length ?? null,
      credentialPersistenceAvailable: await this.options.credentials.isPersistenceAvailable(),
      parameters: resolved.parameters,
      capabilities: resolved.capabilities,
    };
  }

  async updateProvider(providerId: string): Promise<ProviderInfo> {
    // Select a configured Provider and retain the current model when it is available there.
    const config = this.configuration.get();
    const provider = config.llm.providers[providerId];
    if (provider === undefined) {
      throw new AppError("CONFIG_ERROR", `Software configuration has no Provider: ${providerId}`);
    }
    const selectedModel = config.llm.selectedModel;
    const modelId =
      selectedModel !== null && provider.models[selectedModel] !== undefined
        ? selectedModel
        : Object.keys(provider.models)[0];
    if (modelId === undefined) {
      throw new AppError("CONFIG_ERROR", `Provider ${providerId} has no configured models.`);
    }
    await this.configuration.updateSelection(providerId, modelId);
    this.invalidate();
    return this.getCurrentInfo();
  }

  async updateModel(modelId: string): Promise<ProviderInfo> {
    // Select a model from the current Provider catalog.
    const current = this.resolveConfiguration();
    const model = this.configuration.get().llm.providers[current.providerId]?.models[modelId];
    if (model === undefined) {
      throw new AppError("CONFIG_ERROR", `Provider ${current.providerId} has no model: ${modelId}`);
    }
    await this.configuration.updateSelection(current.providerId, modelId);
    return this.getCurrentInfo();
  }

  async updateModelParameters(parameters: ModelParameters): Promise<ProviderInfo> {
    // Persist model parameters after checking them against current capabilities.
    const current = this.resolveConfiguration();
    validateModelParameters(parameters, current.capabilities);
    await this.configuration.updateModelParameters(parameters);
    return this.getCurrentInfo();
  }

  async updateConfiguration(input: UpdateProviderConfigurationInput): Promise<ProviderInfo> {
    // Persist OpenAI-compatible connection settings and invalidate its hidden client.
    // 1. Validate the model in the current Provider catalog.
    // 2. Persist an optional replacement secret before ordinary configuration.
    // 3. Clear the cached Provider so later executions observe the saved settings.
    const current = this.resolveConfiguration();
    if (current.providerId !== "openai-compatible") {
      throw new AppError("CONFIG_ERROR", "Only OpenAI-compatible configuration is editable.");
    }
    if (
      this.configuration.get().llm.providers[current.providerId]?.models[input.modelId] ===
      undefined
    ) {
      throw new AppError(
        "CONFIG_ERROR",
        `Provider ${current.providerId} has no model: ${input.modelId}`,
      );
    }
    if (input.apiKey !== undefined && !(await this.options.credentials.isPersistenceAvailable())) {
      throw new AppError("CONFIG_ERROR", "Secure credential storage is unavailable.");
    }
    if (input.apiKey !== undefined) {
      await this.options.credentials.saveApiKey(current.providerId, input.apiKey);
      this.invalidate();
    }
    await this.configuration.updateOpenAiCompatible(input.baseUrl, input.modelId);
    this.invalidate();
    return this.getCurrentInfo();
  }

  async validateCurrentConfiguration(signal?: AbortSignal): Promise<ProviderHealth> {
    const resolved = this.resolveConfiguration();
    return (await this.getProvider(resolved)).validateConfiguration(signal);
  }

  async createExecution(): Promise<ModelExecution> {
    // Freeze the current model selection and hidden Provider for one business operation.
    // 1. Resolve and validate the current identity, parameters, and capabilities.
    // 2. Reuse or construct the private concrete Provider client.
    // 3. Return a sender that injects the frozen model settings into every request.
    const resolved = this.resolveConfiguration();
    const provider = await this.getProvider(resolved);
    return {
      providerId: resolved.providerId,
      providerName: resolved.providerName,
      model: resolved.modelId,
      modelName: resolved.modelName,
      parameters: resolved.parameters,
      capabilities: resolved.capabilities,
      send: (request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> =>
        provider.stream(
          {
            ...request,
            model: resolved.modelId,
            thinking: { type: resolved.parameters.reasoningEnabled ? "enabled" : "disabled" },
            ...(!resolved.parameters.reasoningEnabled ||
            resolved.parameters.reasoningEffort === undefined
              ? {}
              : { reasoningEffort: resolved.parameters.reasoningEffort }),
          },
          signal,
        ),
    };
  }

  invalidate(): void {
    this.cachedProvider = undefined;
    this.pendingProvider = undefined;
    this.cacheRevision += 1;
  }

  private resolveConfiguration(): ResolvedProviderConfiguration {
    // Resolve one immutable effective model configuration from software settings and overrides.
    // 1. Resolve the selected Provider and model and require a catalog capability entry.
    // 2. Validate model parameters against the selected model's declared capabilities.
    // 3. Apply command-scoped endpoint and timeout overrides for Provider construction.
    const config = this.configuration.get();
    const overrides = this.options.overrides;
    const providerId = overrides?.providerId ?? config.llm.selectedProvider;
    const modelId = overrides?.modelId ?? config.llm.selectedModel;
    if (providerId === null || modelId === null) {
      throw new AppError("CONFIG_ERROR", "The current Provider or model is not configured.");
    }
    const provider = config.llm.providers[providerId];
    if (provider === undefined) {
      throw new AppError("CONFIG_ERROR", `Software configuration has no Provider: ${providerId}`);
    }
    const model = provider.models[modelId];
    if (model === undefined) {
      throw new AppError("CONFIG_ERROR", `Provider ${providerId} has no model: ${modelId}`);
    }
    const capabilities: ModelCapabilities = {
      contextWindowTokens: overrides?.contextWindowTokens ?? model.contextWindowTokens,
      maxOutputTokens: overrides?.maxOutputTokens ?? model.maxOutputTokens,
      reasoningSupported: model.reasoningSupported,
      reasoningEfforts: model.reasoningEfforts,
    };
    validateModelParameters(config.llm.modelParameters, capabilities);
    const environment = this.options.environment ?? process.env;
    const baseUrl = overrides?.baseUrl ?? environment.OPENAI_BASE_URL ?? provider.baseUrl;
    return {
      providerId,
      providerName: provider.displayName,
      modelId,
      modelName: model.displayName,
      baseUrl,
      requiresApiKey: providerId === "openai-compatible",
      parameters: config.llm.modelParameters,
      capabilities,
      factoryOptions: {
        baseUrl,
        connectionTimeoutMs: overrides?.connectionTimeoutMs ?? config.llm.timeouts.connectionMs,
        streamIdleTimeoutMs: overrides?.streamIdleTimeoutMs ?? config.llm.timeouts.streamIdleMs,
        overallTimeoutMs: overrides?.overallTimeoutMs ?? config.llm.timeouts.overallMs,
      },
    };
  }

  private async getProvider(resolved: ResolvedProviderConfiguration): Promise<ModelProvider> {
    // Reuse one internal Provider instance for the current non-secret configuration identity.
    // 1. Return the cached instance when its construction settings still match.
    // 2. Share an in-flight construction with concurrent callers for the same identity.
    // 3. Publish the completed instance and clear the temporary construction promise.
    const revision = this.cacheRevision;
    const identity = JSON.stringify({
      cacheRevision: revision,
      providerId: resolved.providerId,
      ...resolved.factoryOptions,
    });
    if (this.cachedProvider?.identity === identity) return this.cachedProvider.provider;
    if (this.pendingProvider !== undefined) {
      const pending = await this.pendingProvider;
      if (pending.identity === identity) return pending.provider;
    }

    const pending = this.createCachedProvider(identity, resolved);
    this.pendingProvider = pending;
    try {
      const cached = await pending;
      if (revision === this.cacheRevision) this.cachedProvider = cached;
      return cached.provider;
    } finally {
      if (this.pendingProvider === pending) this.pendingProvider = undefined;
    }
  }

  private async createCachedProvider(
    identity: string,
    resolved: ResolvedProviderConfiguration,
  ): Promise<CachedProvider> {
    const apiKey = await this.options.credentials.readApiKey(resolved.providerId);
    const provider = this.providerFactory(resolved.providerId, {
      ...resolved.factoryOptions,
      environment: apiKey === undefined ? {} : { CLEODOC_API_KEY: apiKey },
    });
    return { identity, provider };
  }
}

function validateModelParameters(
  parameters: ModelParameters,
  capabilities: ModelCapabilities,
): void {
  // Reject enabled reasoning settings that the selected model cannot satisfy.
  if (parameters.reasoningEnabled && !capabilities.reasoningSupported) {
    throw new AppError("CONFIG_ERROR", "The current model does not support reasoning.");
  }
  if (
    parameters.reasoningEnabled &&
    parameters.reasoningEffort !== undefined &&
    !capabilities.reasoningEfforts.includes(parameters.reasoningEffort)
  ) {
    throw new AppError("CONFIG_ERROR", "The current model does not support this reasoning effort.");
  }
}

export class EnvironmentProviderCredentialStore implements ProviderCredentialStore {
  constructor(private readonly environment: NodeJS.ProcessEnv = process.env) {}

  async isPersistenceAvailable(): Promise<boolean> {
    return false;
  }

  async readApiKey(providerId: string): Promise<string | undefined> {
    return providerId === "openai-compatible" ? this.environment.CLEODOC_API_KEY : undefined;
  }

  async saveApiKey(): Promise<void> {
    throw new AppError("CONFIG_ERROR", "CLI does not persist API keys.");
  }
}
