import {
  getSoftwareConfig,
  getSoftwareDefaultConfigPath,
  getSoftwareUserConfigPath,
} from "../../../../packages/config/src/index.js";
import { AppError } from "../../../../packages/contracts/src/index.js";
import { assertOnlyOptions, type ParsedArguments } from "../arguments.js";
import { providerServiceFromArguments } from "./chat-settings.js";
import type { CliCommandContext } from "./command-context.js";

export async function runConfigCommand(
  parsed: ParsedArguments,
  context: CliCommandContext,
): Promise<void> {
  // Print software paths, project state, and renderer-safe current Provider information.
  // 1. Validate the command shape and read the current application snapshots.
  // 2. Resolve Provider and model display information through ProviderService.
  // 3. Report only whether environment overrides exist, never their values.
  assertOnlyOptions(parsed, []);
  if (parsed.positionals.length !== 0) {
    throw new AppError("VALIDATION_ERROR", "用法：cleo config");
  }
  const config = getSoftwareConfig();
  const state = await context.appState.read();
  const providerInfo =
    config.llm.selectedProvider === null || config.llm.selectedModel === null
      ? null
      : await providerServiceFromArguments(
          config.llm.selectedProvider,
          config.llm.selectedModel,
          parsed,
        ).getCurrentInfo();
  context.output.write(`默认配置：${getSoftwareDefaultConfigPath()}\n`);
  context.output.write(`用户配置：${getSoftwareUserConfigPath()}\n`);
  context.output.write(`当前项目：${state.currentProject ?? "未设置"}\n`);
  context.output.write(
    `当前 Provider：${providerInfo === null ? "未设置" : `${providerInfo.providerName} (${providerInfo.providerId})`}\n`,
  );
  context.output.write(
    `当前模型：${providerInfo === null ? "未设置" : `${providerInfo.modelName} (${providerInfo.modelId})`}\n`,
  );
  context.output.write(`CLEODOC_API_KEY：${process.env.CLEODOC_API_KEY ? "已设置" : "未设置"}\n`);
  context.output.write(
    `OPENAI_BASE_URL：${process.env.OPENAI_BASE_URL ? "已设置" : "使用默认值"}\n`,
  );
  context.output.write(
    `OLLAMA_BASE_URL：${process.env.OLLAMA_BASE_URL ? "已设置" : "使用默认值"}\n`,
  );
}
