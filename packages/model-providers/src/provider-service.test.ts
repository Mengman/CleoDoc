import { readFile } from "node:fs/promises";

import { parse } from "yaml";
import { describe, expect, it } from "vitest";

import { softwareConfigSchema, type SoftwareConfig } from "../../config/src/index.js";
import type {
  ModelEvent,
  ModelProvider,
  ModelRequest,
  ProviderHealth,
} from "../../contracts/src/index.js";
import {
  ProviderService,
  type ProviderConfigurationStore,
  type ProviderCredentialStore,
} from "./provider-service.js";

describe("ProviderService", () => {
  it("reports current provider information without exposing the API key", async () => {
    const fixture = await createFixture();

    await expect(fixture.service.getCurrentInfo()).resolves.toEqual({
      providerId: "openai-compatible",
      providerName: "OpenAI-compatible",
      modelId: "deepseek-v4-flash",
      modelName: "DeepSeek V4 Flash",
      baseUrl: "https://api.deepseek.com",
      apiKeyConfigured: true,
      apiKeyLength: 14,
      credentialPersistenceAvailable: true,
      parameters: { reasoningEnabled: true, reasoningEffort: "medium" },
      capabilities: {
        contextWindowTokens: 1_000_000,
        maxOutputTokens: 384_000,
        reasoningSupported: true,
        reasoningEfforts: ["low", "medium", "high"],
      },
    });
  });

  it("uses persisted configuration for subsequent messages", async () => {
    const fixture = await createFixture();
    await collect(fixture.service);

    const info = await fixture.service.updateConfiguration({
      baseUrl: "https://gateway.example/v1",
      modelId: "deepseek-v4-flash",
      apiKey: "sk-replacement",
    });
    await collect(fixture.service);

    expect(info.baseUrl).toBe("https://gateway.example/v1");
    expect(info.apiKeyLength).toBe(14);
    expect(fixture.credentials.apiKey).toBe("sk-replacement");
    expect(fixture.requests.at(-1)).toMatchObject({
      baseUrl: "https://gateway.example/v1",
      apiKey: "sk-replacement",
    });
  });

  it("uses a newly saved credential for subsequent messages", async () => {
    const fixture = await createFixture();
    await collect(fixture.service);

    await fixture.service.updateConfiguration({
      baseUrl: "https://api.deepseek.com",
      modelId: "deepseek-v4-flash",
      apiKey: "sk-new-secret",
    });
    await collect(fixture.service);

    expect(fixture.requests.at(-1)?.apiKey).toBe("sk-new-secret");
  });

  it("freezes the current provider and model for one execution", async () => {
    const fixture = await createFixture();
    const execution = await fixture.service.createExecution();
    expect(execution).toMatchObject({
      providerId: "openai-compatible",
      model: "deepseek-v4-flash",
    });
    await drain(execution.send({ messages: [] }, new AbortController().signal));
    expect(fixture.requests.at(-1)?.request).toMatchObject({
      model: "deepseek-v4-flash",
      thinking: { type: "enabled" },
      reasoningEffort: "medium",
    });

    await fixture.service.updateModelParameters({ reasoningEnabled: false });
    await drain(execution.send({ messages: [] }, new AbortController().signal));
    expect(fixture.requests.at(-1)?.request).toMatchObject({
      thinking: { type: "enabled" },
      reasoningEffort: "medium",
    });

    const nextExecution = await fixture.service.createExecution();
    await drain(nextExecution.send({ messages: [] }, new AbortController().signal));
    expect(fixture.requests.at(-1)?.request).toMatchObject({
      thinking: { type: "disabled" },
    });
    expect(fixture.requests.at(-1)?.request).not.toHaveProperty("reasoningEffort");
  });
});

class MemoryCredentialStore implements ProviderCredentialStore {
  constructor(public apiKey: string | undefined = "sk-secret-test") {}

  async isPersistenceAvailable(): Promise<boolean> {
    return true;
  }

  async readApiKey(): Promise<string | undefined> {
    return this.apiKey;
  }

  async saveApiKey(_providerId: string, apiKey: string): Promise<void> {
    this.apiKey = apiKey;
  }
}

class RecordingProvider implements ModelProvider {
  readonly id = "openai-compatible";
  readonly displayName = "OpenAI-compatible";

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string | undefined,
    private readonly requests: ProviderRequest[],
  ) {}

  async validateConfiguration(): Promise<ProviderHealth> {
    return { ok: true, message: "ready" };
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push({ baseUrl: this.baseUrl, apiKey: this.apiKey, request });
    yield { type: "text-delta", text: "ok" };
    yield { type: "done", finishReason: "stop" };
  }
}

interface ProviderRequest {
  readonly baseUrl: string;
  readonly apiKey: string | undefined;
  readonly request: ModelRequest;
}

async function createFixture(): Promise<{
  readonly service: ProviderService;
  readonly credentials: MemoryCredentialStore;
  readonly requests: ProviderRequest[];
}> {
  // Build an isolated ProviderService around the packaged configuration snapshot.
  // 1. Load a complete valid configuration and expose an in-memory update boundary.
  // 2. Record credential and concrete Provider activity without external I/O.
  // 3. Return the service together with observability required by each assertion.
  const source = await readFile("resources/config/software-default.yaml", "utf8");
  let config: SoftwareConfig = softwareConfigSchema.parse(parse(source));
  const configuration: ProviderConfigurationStore = {
    get: () => config,
    updateOpenAiCompatible: async (baseUrl, modelId) => {
      config = {
        ...config,
        llm: {
          ...config.llm,
          selectedProvider: "openai-compatible",
          selectedModel: modelId,
          providers: {
            ...config.llm.providers,
            "openai-compatible": {
              ...config.llm.providers["openai-compatible"]!,
              baseUrl,
            },
          },
        },
      };
    },
    updateSelection: async (providerId, modelId) => {
      config = {
        ...config,
        llm: { ...config.llm, selectedProvider: providerId, selectedModel: modelId },
      };
    },
    updateModelParameters: async (parameters) => {
      config = { ...config, llm: { ...config.llm, modelParameters: parameters } };
    },
  };
  const credentials = new MemoryCredentialStore();
  const requests: ProviderRequest[] = [];
  const service = new ProviderService({
    configuration,
    credentials,
    providerFactory: (_providerId, options) => {
      return new RecordingProvider(options.baseUrl, options.environment?.CLEODOC_API_KEY, requests);
    },
  });
  return { service, credentials, requests };
}

async function collect(service: ProviderService): Promise<ModelEvent[]> {
  const execution = await service.createExecution();
  return drain(execution.send({ messages: [] }, new AbortController().signal));
}

async function drain(events: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const collected: ModelEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}
