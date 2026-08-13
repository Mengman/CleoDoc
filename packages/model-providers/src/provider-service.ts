import {
  getSoftwareConfig,
  saveOpenAiCompatibleSoftwareConfig,
  type SoftwareConfig,
} from "../../config/src/index.js";
import type {
  ModelEvent,
  ModelMessageSender,
  ModelProvider,
  ModelSendInput,
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
}

export interface ProviderServiceOverrides {
  readonly providerId?: string;
  readonly modelId?: string;
  readonly baseUrl?: string;
  readonly connectionTimeoutMs?: number;
  readonly streamIdleTimeoutMs?: number;
  readonly overallTimeoutMs?: number;
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

  get id(): string {
    return this.resolveConfiguration().providerId;
  }

  get displayName(): string {
    return this.resolveConfiguration().providerName;
  }

  async getCurrentInfo(): Promise<ProviderInfo> {
    // Return the effective Provider and model selection without exposing its credential.
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
    };
  }

  async updateConfiguration(input: UpdateProviderConfigurationInput): Promise<ProviderInfo> {
    // Persist the current OpenAI-compatible selection and invalidate its Provider instance.
    // 1. Restrict this transition API to the currently supported configurable Provider.
    // 2. Persist an optional replacement secret before changing the ordinary configuration.
    // 3. Clear the cached Provider so the next request uses the new effective settings.
    const current = this.resolveConfiguration();
    if (current.providerId !== "openai-compatible") {
      throw new AppError("CONFIG_ERROR", "当前版本只支持修改 OpenAI-compatible 配置。");
    }
    if (
      this.configuration.get().llm.providers[current.providerId]?.models[input.modelId] ===
      undefined
    ) {
      throw new AppError(
        "CONFIG_ERROR",
        `Provider ${current.providerId} 中没有模型：${input.modelId}`,
      );
    }
    if (input.apiKey !== undefined && !(await this.options.credentials.isPersistenceAvailable())) {
      throw new AppError("CONFIG_ERROR", "当前系统没有可用的安全凭据存储，API Key 未保存。");
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
    // Validate the effective Provider through its cached internal instance.
    const resolved = this.resolveConfiguration();
    return (await this.getProvider(resolved)).validateConfiguration(signal);
  }

  async *send(input: ModelSendInput, signal: AbortSignal): AsyncIterable<ModelEvent> {
    // Validate the requested identity and forward the model request through the cached Provider.
    const resolved = this.resolveConfiguration();
    if (
      input.providerId !== resolved.providerId ||
      input.model !== resolved.modelId ||
      input.request.model !== input.model
    ) {
      throw new AppError(
        "VALIDATION_ERROR",
        `对话要求 ${input.providerId}/${input.model}，当前配置为 ${resolved.providerId}/${resolved.modelId}，不能静默切换。`,
      );
    }
    const provider = await this.getProvider(resolved);
    yield* provider.stream(input.request, signal);
  }

  invalidate(): void {
    this.cachedProvider = undefined;
    this.pendingProvider = undefined;
    this.cacheRevision += 1;
  }

  private resolveConfiguration(): ResolvedProviderConfiguration {
    // Resolve one immutable effective Provider configuration from software settings and overrides.
    // 1. Select the current Provider and model, rejecting missing catalog entries.
    // 2. Apply command-scoped endpoint and timeout overrides without changing persisted state.
    // 3. Return only the fields required to identify and construct the internal Provider.
    const config = this.configuration.get();
    const overrides = this.options.overrides;
    const providerId = overrides?.providerId ?? config.llm.selectedProvider;
    const modelId = overrides?.modelId ?? config.llm.selectedModel;
    if (providerId === null || modelId === null) {
      throw new AppError("CONFIG_ERROR", "尚未配置当前 Provider 或模型。");
    }
    const provider = config.llm.providers[providerId];
    if (provider === undefined) {
      throw new AppError("CONFIG_ERROR", `软件配置中没有 Provider：${providerId}`);
    }
    const model = provider.models[modelId];
    if (model === undefined && overrides?.modelId === undefined) {
      throw new AppError("CONFIG_ERROR", `Provider ${providerId} 中没有模型：${modelId}`);
    }
    const environment = this.options.environment ?? process.env;
    const baseUrl =
      overrides?.baseUrl ??
      (providerId === "ollama" ? environment.OLLAMA_BASE_URL : environment.OPENAI_BASE_URL) ??
      provider.baseUrl;
    return {
      providerId,
      providerName: provider.displayName,
      modelId,
      modelName: model?.displayName ?? modelId,
      baseUrl,
      requiresApiKey: providerId === "openai-compatible",
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
    // Read the secret inside the service and construct the hidden concrete Provider.
    const apiKey = await this.options.credentials.readApiKey(resolved.providerId);
    const provider = this.providerFactory(resolved.providerId, {
      ...resolved.factoryOptions,
      environment: apiKey === undefined ? {} : { CLEODOC_API_KEY: apiKey },
    });
    return { identity, provider };
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
    throw new AppError("CONFIG_ERROR", "CLI 不会持久化 API Key，请使用进程环境变量。");
  }
}
