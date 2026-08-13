import { readFile } from "node:fs/promises";

import { parse } from "yaml";
import { describe, expect, it, vi } from "vitest";

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
    });
  });

  it("reuses one concrete provider for repeated sends", async () => {
    const fixture = await createFixture();

    await collect(fixture.service);
    await collect(fixture.service);

    expect(fixture.providers).toHaveLength(1);
    expect(fixture.providers[0]?.requests).toHaveLength(2);
    expect(fixture.factoryEnvironments).toEqual([{ CLEODOC_API_KEY: "sk-secret-test" }]);
  });

  it("persists configuration through the service and rebuilds the cached provider", async () => {
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
    expect(fixture.providers).toHaveLength(2);
    expect(fixture.factoryBaseUrls).toEqual([
      "https://api.deepseek.com",
      "https://gateway.example/v1",
    ]);
  });

  it("rebuilds the provider when only its credential changes", async () => {
    const fixture = await createFixture();
    await collect(fixture.service);

    await fixture.service.updateConfiguration({
      baseUrl: "https://api.deepseek.com",
      modelId: "deepseek-v4-flash",
      apiKey: "sk-new-secret",
    });
    await collect(fixture.service);

    expect(fixture.providers).toHaveLength(2);
    expect(fixture.factoryEnvironments).toEqual([
      { CLEODOC_API_KEY: "sk-secret-test" },
      { CLEODOC_API_KEY: "sk-new-secret" },
    ]);
  });

  it("rejects a request that would silently switch provider or model", async () => {
    const fixture = await createFixture();

    await expect(
      drain(
        fixture.service.send(
          {
            providerId: "ollama",
            model: "other-model",
            request: { model: "other-model", messages: [] },
          },
          new AbortController().signal,
        ),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(fixture.providers).toHaveLength(0);
  });

  it("does not republish an in-flight provider after configuration changes", async () => {
    const fixture = await createFixture();
    let releaseCredential: (() => void) | undefined;
    const credentialGate = new Promise<void>((resolve) => {
      releaseCredential = resolve;
    });
    const originalRead = fixture.credentials.readApiKey.bind(fixture.credentials);
    const readApiKey = vi
      .spyOn(fixture.credentials, "readApiKey")
      .mockImplementationOnce(async () => {
        await credentialGate;
        return originalRead();
      });

    const firstSend = collect(fixture.service);
    await vi.waitFor(() => expect(readApiKey).toHaveBeenCalledTimes(1));
    fixture.service.invalidate();
    releaseCredential?.();
    await firstSend;
    await collect(fixture.service);

    expect(fixture.providers).toHaveLength(2);
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
  readonly requests: ModelRequest[] = [];

  async validateConfiguration(): Promise<ProviderHealth> {
    return { ok: true, message: "ready" };
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    yield { type: "text-delta", text: "ok" };
    yield { type: "done", finishReason: "stop" };
  }
}

async function createFixture(): Promise<{
  readonly service: ProviderService;
  readonly credentials: MemoryCredentialStore;
  readonly providers: RecordingProvider[];
  readonly factoryBaseUrls: string[];
  readonly factoryEnvironments: NodeJS.ProcessEnv[];
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
  };
  const credentials = new MemoryCredentialStore();
  const providers: RecordingProvider[] = [];
  const factoryBaseUrls: string[] = [];
  const factoryEnvironments: NodeJS.ProcessEnv[] = [];
  const service = new ProviderService({
    configuration,
    credentials,
    providerFactory: (_providerId, options) => {
      const provider = new RecordingProvider();
      providers.push(provider);
      factoryBaseUrls.push(options.baseUrl);
      factoryEnvironments.push(options.environment ?? {});
      return provider;
    },
  });
  return { service, credentials, providers, factoryBaseUrls, factoryEnvironments };
}

async function collect(service: ProviderService): Promise<ModelEvent[]> {
  return drain(
    service.send(
      {
        providerId: "openai-compatible",
        model: "deepseek-v4-flash",
        request: { model: "deepseek-v4-flash", messages: [] },
      },
      new AbortController().signal,
    ),
  );
}

async function drain(events: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const collected: ModelEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}
