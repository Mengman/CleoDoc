import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseDocument } from "yaml";
import { z } from "zod";

import { AppError } from "../../contracts/src/index.js";
import { resolveCleoDocHome } from "./config-paths.js";
import { writeYamlAtomic } from "./yaml-file.js";
import {
  softwareConfigSchema,
  type SoftwareConfig,
  type SoftwareConfigLoadResult,
  type SoftwareConfigWarning,
} from "./software-config-schema.js";

const positiveInteger = z.number().int().positive();
const positiveRatio = z.number().positive().max(1);
const USER_FIELD_SCHEMAS = new Map<string, z.ZodType>([
  ["gpuAcceleration", z.boolean()],
  ["schemaVersion", z.literal(1)],
  ["llm.selectedProvider", z.string().min(1).nullable()],
  ["llm.selectedModel", z.string().min(1).nullable()],
  ["llm.providers.openai-compatible.baseUrl", z.url()],
  ["llm.timeouts.connectionMs", positiveInteger],
  ["llm.timeouts.streamIdleMs", positiveInteger],
  ["llm.timeouts.overallMs", positiveInteger],
  ["context.nextUserInputReserveTokens", positiveInteger],
  ["context.nextUserInputReserveRatio", positiveRatio],
  ["context.safetyMarginRatio", positiveRatio],
  ["context.softCompactionRatio", positiveRatio],
  ["context.hardCompactionRatio", positiveRatio],
  ["agent.maxToolRounds", positiveInteger],
  ["agent.compaction.summaryTargetRatio", positiveRatio],
  ["agent.compaction.summaryTargetMinTokens", positiveInteger],
  ["agent.compaction.summaryTargetMaxTokens", positiveInteger],
  ["agent.compaction.segmentSummaryMaxTokens", positiveInteger],
  ["agent.compaction.segmentPayloadTargetRatio", positiveRatio],
  ["agent.compaction.splitSearchWindowRatio", positiveRatio],
  ["agent.compaction.resultMinLimitTokens", positiveInteger],
  ["agent.compaction.resultMaxLimitTokens", positiveInteger],
  ["agent.compaction.resultTargetMultiplier", positiveInteger],
  ["rag.chunking.splitSearchWindowRatio", positiveRatio],
  ["rag.retrieval.candidateLimit", positiveInteger.max(100)],
  ["rag.retrieval.rrfK", positiveInteger],
  ["rag.retrieval.contextMaxCharacters", positiveInteger],
  ["rag.retrieval.maxSourceRatio", positiveRatio],
  ["rag.languageDetection.minBlockUnits", positiveInteger],
  ["rag.embedding.worker.chunkBatchSize", positiveInteger],
  ["materials.maxImportBytes", positiveInteger],
  ["database.busyTimeoutMs", positiveInteger],
  ["debug.enabled", z.boolean()],
]);

export interface SoftwareConfigServiceOptions {
  environment?: NodeJS.ProcessEnv;
  defaultConfigPath?: string;
}

export class SoftwareConfigService {
  readonly homeDirectory: string;
  readonly userConfigPath: string;
  private resolvedDefaultConfigPath: string | null = null;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly explicitDefaultConfigPath?: string;

  constructor(options: SoftwareConfigServiceOptions = {}) {
    this.environment = options.environment ?? process.env;
    this.homeDirectory = resolveCleoDocHome(this.environment);
    this.userConfigPath = path.join(this.homeDirectory, "config.yaml");
    this.explicitDefaultConfigPath = options.defaultConfigPath;
  }

  async load(): Promise<SoftwareConfigLoadResult> {
    const defaultConfigPath = await this.resolveDefaultConfigPath();
    this.resolvedDefaultConfigPath = defaultConfigPath;
    const defaults = await this.readDefaults(defaultConfigPath);
    const userContent = await readFile(this.userConfigPath, "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      },
    );
    if (userContent === null) {
      await writeYamlAtomic(this.userConfigPath, { schemaVersion: 1 });
      return { config: defaults, warnings: [] };
    }

    const warnings: SoftwareConfigWarning[] = [];
    const userDocument = parseDocument(userContent, { uniqueKeys: true });
    if (userDocument.errors.length > 0) {
      return {
        config: defaults,
        warnings: [
          {
            path: "config.yaml",
            message: `用户配置 YAML 无效，已使用软件默认配置：${userDocument.errors[0]!.message}`,
          },
        ],
      };
    }
    const raw = userDocument.toJS({ maxAliasCount: 0 });
    if (!isRecord(raw)) {
      return {
        config: defaults,
        warnings: [{ path: "config.yaml", message: "用户配置必须是对象，已使用软件默认配置。" }],
      };
    }

    const merged = structuredClone(defaults);
    applyUserValues(raw, merged as unknown as Record<string, unknown>, warnings);
    repairRelatedFields(merged, defaults, warnings);
    const parsed = softwareConfigSchema.safeParse(merged);
    if (!parsed.success) {
      throw new AppError("CONFIG_ERROR", "合并后的软件配置无效。", {
        details: { issues: formatIssues(parsed.error.issues) },
      });
    }
    return { config: parsed.data, warnings };
  }

  async saveOpenAiCompatibleSelection(baseUrl: string, modelName: string): Promise<void> {
    // Preserve existing user overrides while updating the temporary desktop LLM connection.
    // 1. Read and validate the current user YAML before making any changes.
    // 2. Merge only the provider, model, and OpenAI-compatible endpoint fields.
    // 3. Atomically replace the user YAML so interrupted writes cannot corrupt it.
    const userConfig = await this.readUserConfigForUpdate();
    const llm = isRecord(userConfig.llm) ? userConfig.llm : {};
    const providers = isRecord(llm.providers) ? llm.providers : {};
    const openAiCompatible = isRecord(providers["openai-compatible"])
      ? providers["openai-compatible"]
      : {};
    await writeYamlAtomic(this.userConfigPath, {
      ...userConfig,
      schemaVersion: 1,
      llm: {
        ...llm,
        selectedProvider: "openai-compatible",
        selectedModel: modelName,
        providers: {
          ...providers,
          "openai-compatible": { ...openAiCompatible, baseUrl },
        },
      },
    });
  }

  get defaultConfigPath(): string {
    if (this.resolvedDefaultConfigPath === null) {
      throw new AppError("CONFIG_ERROR", "软件默认配置尚未加载。");
    }
    return this.resolvedDefaultConfigPath;
  }

  private async readDefaults(defaultConfigPath: string): Promise<SoftwareConfig> {
    const content = await readFile(defaultConfigPath, "utf8").catch((error: unknown) => {
      throw new AppError("CONFIG_ERROR", "找不到随软件发行的默认配置。", {
        cause: error,
        details: { defaultConfigPath },
      });
    });
    const document = parseDocument(content, { uniqueKeys: true });
    if (document.errors.length > 0) {
      throw new AppError("CONFIG_ERROR", "软件默认配置 YAML 无效。", {
        details: { message: document.errors[0]!.message, defaultConfigPath },
      });
    }
    const parsed = softwareConfigSchema.safeParse(document.toJS({ maxAliasCount: 0 }));
    if (!parsed.success) {
      throw new AppError("CONFIG_ERROR", "软件默认配置未通过 Schema 校验。", {
        details: { issues: formatIssues(parsed.error.issues), defaultConfigPath },
      });
    }
    return parsed.data;
  }

  private async readUserConfigForUpdate(): Promise<Record<string, unknown>> {
    // Read a writable user configuration without silently replacing malformed content.
    const content = await readFile(this.userConfigPath, "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return "schemaVersion: 1\n";
        throw error;
      },
    );
    const document = parseDocument(content, { uniqueKeys: true });
    if (document.errors.length > 0) {
      throw new AppError("CONFIG_ERROR", "用户配置 YAML 无效，无法保存模型配置。");
    }
    const raw = document.toJS({ maxAliasCount: 0 });
    if (!isRecord(raw)) {
      throw new AppError("CONFIG_ERROR", "用户配置必须是对象，无法保存模型配置。");
    }
    return raw;
  }

  private async resolveDefaultConfigPath(): Promise<string> {
    const environmentPath = this.environment.CLEODOC_DEFAULT_CONFIG;
    if (this.explicitDefaultConfigPath !== undefined)
      return path.resolve(this.explicitDefaultConfigPath);
    if (environmentPath !== undefined && environmentPath.trim() !== "")
      return path.resolve(environmentPath);

    const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
      path.resolve(moduleDirectory, "../../../resources/config/software-default.yaml"),
      path.resolve(moduleDirectory, "../../../../resources/config/software-default.yaml"),
    ];
    for (const candidate of candidates) {
      if (
        await access(candidate).then(
          () => true,
          () => false,
        )
      )
        return candidate;
    }
    return candidates[0]!;
  }
}

function applyUserValues(
  raw: Record<string, unknown>,
  target: Record<string, unknown>,
  warnings: SoftwareConfigWarning[],
  prefix = "",
): void {
  for (const [key, value] of Object.entries(raw)) {
    const fieldPath = prefix === "" ? key : `${prefix}.${key}`;
    const schema = USER_FIELD_SCHEMAS.get(fieldPath);
    if (schema !== undefined) {
      const parsed = schema.safeParse(value);
      if (parsed.success) setPath(target, fieldPath, parsed.data);
      else warnings.push({ path: fieldPath, message: "配置值无效，已使用软件默认值。" });
      continue;
    }
    if (hasKnownChild(fieldPath) && isRecord(value)) {
      applyUserValues(value, target, warnings, fieldPath);
      continue;
    }
    warnings.push({ path: fieldPath, message: "未知或不可覆盖的配置项，已忽略。" });
  }
}

function repairRelatedFields(
  config: SoftwareConfig,
  defaults: SoftwareConfig,
  warnings: SoftwareConfigWarning[],
): void {
  if (
    config.llm.selectedProvider !== null &&
    config.llm.providers[config.llm.selectedProvider] === undefined
  ) {
    config.llm.selectedProvider = defaults.llm.selectedProvider;
    config.llm.selectedModel = defaults.llm.selectedModel;
    warnings.push({ path: "llm.selectedProvider", message: "Provider 不存在，已恢复默认值。" });
  }
  const selectedProvider = config.llm.selectedProvider;
  if (
    selectedProvider !== null &&
    config.llm.selectedModel !== null &&
    config.llm.providers[selectedProvider]?.models[config.llm.selectedModel] === undefined
  ) {
    config.llm.selectedModel = defaults.llm.selectedModel;
    warnings.push({
      path: "llm.selectedModel",
      message: "模型不在当前 Provider 中，已恢复默认值。",
    });
  }
  if (config.context.softCompactionRatio >= config.context.hardCompactionRatio) {
    config.context.softCompactionRatio = defaults.context.softCompactionRatio;
    config.context.hardCompactionRatio = defaults.context.hardCompactionRatio;
    warnings.push({ path: "context", message: "软压缩阈值必须小于硬阈值，已恢复默认值。" });
  }
  const compaction = config.agent.compaction;
  const defaultCompaction = defaults.agent.compaction;
  if (compaction.summaryTargetMinTokens > compaction.summaryTargetMaxTokens) {
    compaction.summaryTargetMinTokens = defaultCompaction.summaryTargetMinTokens;
    compaction.summaryTargetMaxTokens = defaultCompaction.summaryTargetMaxTokens;
    warnings.push({ path: "agent.compaction", message: "摘要目标上下限无效，已恢复默认值。" });
  }
  if (compaction.resultMinLimitTokens > compaction.resultMaxLimitTokens) {
    compaction.resultMinLimitTokens = defaultCompaction.resultMinLimitTokens;
    compaction.resultMaxLimitTokens = defaultCompaction.resultMaxLimitTokens;
    warnings.push({ path: "agent.compaction", message: "压缩结果上下限无效，已恢复默认值。" });
  }
}

function hasKnownChild(pathPrefix: string): boolean {
  const prefix = `${pathPrefix}.`;
  return [...USER_FIELD_SCHEMAS.keys()].some((pathValue) => pathValue.startsWith(prefix));
}

function setPath(target: Record<string, unknown>, fieldPath: string, value: unknown): void {
  const segments = fieldPath.split(".");
  let current = target;
  for (const segment of segments.slice(0, -1))
    current = current[segment] as Record<string, unknown>;
  current[segments.at(-1)!] = value;
}

function formatIssues(
  issues: readonly z.core.$ZodIssue[],
): Array<{ path: string; message: string }> {
  return issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
