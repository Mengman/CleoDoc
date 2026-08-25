import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SoftwareConfigService } from "./software-config-service.js";

const temporaryDirectories: string[] = [];
const defaultConfigPath = path.resolve("resources/config/software-default.yaml");

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("SoftwareConfigService", () => {
  it("loads packaged YAML when the user file is absent", async () => {
    const home = await createHome();
    const result = await createService(home).load();

    expect(result.warnings).toEqual([]);
    expect(result.config.llm.timeouts.connectionMs).toBe(60_000);
    expect(result.config.rag.chunking).toEqual({
      splitSearchWindowRatio: 0.75,
    });
    expect(result.config.rag.retrieval).toEqual({
      candidateLimit: 20,
      rrfK: 60,
      contextMaxCharacters: 12_000,
      maxSourceRatio: 0.6,
    });
    expect(result.config.rag.languageDetection.minBlockUnits).toBe(50);
    expect(result.config.rag.embedding.worker.chunkBatchSize).toBe(16);
    expect(result.config.gpuAcceleration).toBe(true);
    expect(result.config.rag.embedding.models.zh).toMatchObject({
      modelId: "bge-small-zh-v1.5-q8_0",
      maxInputTokens: 512,
    });
    expect(await readFile(path.join(home, "config.yaml"), "utf8")).toContain("schemaVersion: 1");
  });

  it("overrides valid leaves and falls invalid or unknown leaves back to defaults", async () => {
    const home = await createHome();
    await writeFile(
      path.join(home, "config.yaml"),
      `gpuAcceleration: false
llm:
  selectedProvider: missing-provider
  timeouts:
    connectionMs: 90000
context:
  softCompactionRatio: invalid
debug:
  enabled: true
rag:
  languageDetection:
    minBlockUnits: 80
  embedding:
    worker:
      chunkBatchSize: 8
    models:
      zh:
        maxInputTokens: 100
unknownSetting: true
`,
      "utf8",
    );

    const result = await createService(home).load();

    expect(result.config.llm.selectedProvider).toBe("openai-compatible");
    expect(result.config.llm.timeouts.connectionMs).toBe(90_000);
    expect(result.config.context.softCompactionRatio).toBe(0.75);
    expect(result.config.debug.enabled).toBe(true);
    expect(result.config.rag.languageDetection.minBlockUnits).toBe(80);
    expect(result.config.rag.embedding.worker.chunkBatchSize).toBe(8);
    expect(result.config.gpuAcceleration).toBe(false);
    expect(result.config.rag.embedding.models.zh.maxInputTokens).toBe(512);
    expect(result.warnings.map((warning) => warning.path)).toEqual(
      expect.arrayContaining([
        "context.softCompactionRatio",
        "llm.selectedProvider",
        "rag.embedding.models",
        "unknownSetting",
      ]),
    );
  });

  it("repairs invalid relationships after applying otherwise valid leaves", async () => {
    const home = await createHome();
    await writeFile(
      path.join(home, "config.yaml"),
      `context:
  softCompactionRatio: 0.95
  hardCompactionRatio: 0.9
agent:
  compaction:
    summaryTargetMinTokens: 9000
`,
      "utf8",
    );

    const result = await createService(home).load();

    expect(result.config.context.softCompactionRatio).toBe(0.75);
    expect(result.config.context.hardCompactionRatio).toBe(0.9);
    expect(result.config.agent.compaction.summaryTargetMinTokens).toBe(512);
  });

  it("falls an invalid GPU acceleration value back to the packaged default", async () => {
    const home = await createHome();
    await writeFile(
      path.join(home, "config.yaml"),
      `gpuAcceleration: auto
`,
      "utf8",
    );

    const result = await createService(home).load();

    expect(result.config.gpuAcceleration).toBe(true);
    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "gpuAcceleration" })]),
    );
  });

  it("persists the desktop OpenAI-compatible selection without removing other overrides", async () => {
    // Verify the desktop connection writer changes only its authorized configuration fields.
    const home = await createHome();
    const service = createService(home);
    await writeFile(
      path.join(home, "config.yaml"),
      "schemaVersion: 1\ngpuAcceleration: false\n",
      "utf8",
    );

    await service.saveOpenAiCompatibleSelection("https://api.deepseek.com/v1", "deepseek-v4-flash");
    const result = await service.load();

    expect(result.config.gpuAcceleration).toBe(false);
    expect(result.config.llm.selectedProvider).toBe("openai-compatible");
    expect(result.config.llm.selectedModel).toBe("deepseek-v4-flash");
    expect(result.config.llm.providers["openai-compatible"]?.baseUrl).toBe(
      "https://api.deepseek.com/v1",
    );
  });
});

async function createHome(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "cleodoc-config-"));
  temporaryDirectories.push(directory);
  await mkdir(directory, { recursive: true });
  return directory;
}

function createService(home: string): SoftwareConfigService {
  return new SoftwareConfigService({
    environment: { CLEODOC_HOME: home },
    defaultConfigPath,
  });
}
