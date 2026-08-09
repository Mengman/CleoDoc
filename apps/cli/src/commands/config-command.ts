import {
  getSoftwareConfig,
  getSoftwareDefaultConfigPath,
  getSoftwareUserConfigPath,
} from "../../../../packages/config/src/index.js";
import { AppError } from "../../../../packages/contracts/src/index.js";
import { assertOnlyOptions, type ParsedArguments } from "../arguments.js";
import type { CliCommandContext } from "./command-context.js";

export async function runConfigCommand(
  parsed: ParsedArguments,
  context: CliCommandContext,
): Promise<void> {
  assertOnlyOptions(parsed, []);
  if (parsed.positionals.length !== 0) {
    throw new AppError("VALIDATION_ERROR", "用法：cleo config");
  }
  const config = getSoftwareConfig();
  const state = await context.appState.read();
  context.output.write(`默认配置：${getSoftwareDefaultConfigPath()}\n`);
  context.output.write(`用户配置：${getSoftwareUserConfigPath()}\n`);
  context.output.write(`当前项目：${state.currentProject ?? "未设置"}\n`);
  context.output.write(`当前 Provider：${config.llm.selectedProvider ?? "未设置"}\n`);
  context.output.write(`当前模型：${config.llm.selectedModel ?? "未设置"}\n`);
  context.output.write(`CLEODOC_API_KEY：${process.env.CLEODOC_API_KEY ? "已设置" : "未设置"}\n`);
  context.output.write(
    `OPENAI_BASE_URL：${process.env.OPENAI_BASE_URL ? "已设置" : "使用默认值"}\n`,
  );
  context.output.write(
    `OLLAMA_BASE_URL：${process.env.OLLAMA_BASE_URL ? "已设置" : "使用默认值"}\n`,
  );
}
