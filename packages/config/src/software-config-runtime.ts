import { AppError } from "../../contracts/src/index.js";
import type { SoftwareConfig, SoftwareConfigLoadResult } from "./software-config-schema.js";
import {
  SoftwareConfigService,
  type SoftwareConfigServiceOptions,
} from "./software-config-service.js";

interface SoftwareConfigRuntimeState {
  readonly config: SoftwareConfig;
  readonly defaultConfigPath: string;
  readonly userConfigPath: string;
  readonly service: SoftwareConfigService;
}

let state: SoftwareConfigRuntimeState | undefined;

export async function initializeSoftwareConfig(
  options: SoftwareConfigServiceOptions = {},
): Promise<SoftwareConfigLoadResult> {
  const service = new SoftwareConfigService(options);
  const result = await service.load();
  const config = deepFreeze(result.config);
  state = {
    config,
    defaultConfigPath: service.defaultConfigPath,
    userConfigPath: service.userConfigPath,
    service,
  };
  return { config, warnings: result.warnings };
}

export async function saveOpenAiCompatibleSoftwareConfig(
  baseUrl: string,
  modelName: string,
): Promise<SoftwareConfigLoadResult> {
  // Persist the desktop LLM selection and publish a fresh immutable runtime snapshot.
  const current = getState();
  await current.service.saveOpenAiCompatibleSelection(baseUrl, modelName);
  const result = await current.service.load();
  const config = deepFreeze(result.config);
  state = { ...current, config };
  return { config, warnings: result.warnings };
}

export function getSoftwareConfig(): SoftwareConfig {
  return getState().config;
}

export function getSoftwareDefaultConfigPath(): string {
  return getState().defaultConfigPath;
}

export function getSoftwareUserConfigPath(): string {
  return getState().userConfigPath;
}

function getState(): SoftwareConfigRuntimeState {
  if (state === undefined) {
    throw new AppError("CONFIG_ERROR", "软件配置尚未初始化。");
  }
  return state;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
