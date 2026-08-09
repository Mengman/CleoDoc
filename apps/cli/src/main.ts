#!/usr/bin/env node

import { stdin as input, stdout as output } from "node:process";

import { AppStateService, initializeSoftwareConfig } from "../../../packages/config/src/index.js";
import { AppError, asAppError, getExitCode } from "../../../packages/contracts/src/index.js";
import { ProjectService } from "../../../packages/project/src/index.js";
import { parseArguments } from "./arguments.js";
import { runChatCommand } from "./commands/chat-command.js";
import type { CliCommandContext } from "./commands/command-context.js";
import { runConfigCommand } from "./commands/config-command.js";
import { runConversationCommand } from "./commands/conversation-command.js";
import { runDocumentCommand } from "./commands/document-command.js";
import { runEmbeddingCommand } from "./commands/embedding-command.js";
import { runHelpCommand } from "./commands/help-command.js";
import { runIndexCommand } from "./commands/index-command.js";
import { runInitCommand } from "./commands/init-command.js";
import { runMaterialCommand } from "./commands/material-command.js";
import { runOpenCommand } from "./commands/open-command.js";
import { runProviderCommand } from "./commands/provider-command.js";
import { runSearchCommand } from "./commands/search-command.js";
import { runStatusCommand } from "./commands/status-command.js";
import { runVersionCommand } from "./commands/version-command.js";

const appState = new AppStateService();
let commandContext: CliCommandContext | undefined;

async function main(argumentsList: readonly string[]): Promise<void> {
  const parsed = parseArguments(argumentsList);
  if (![undefined, "help", "--help", "-h", "--version", "version"].includes(parsed.command)) {
    await initializeApplication();
  }

  switch (parsed.command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      runHelpCommand(output);
      return;
    case "--version":
    case "version":
      runVersionCommand(output);
      return;
    case "init":
      await runInitCommand(parsed, getCommandContext());
      return;
    case "open":
      await runOpenCommand(parsed, getCommandContext());
      return;
    case "status":
      await runStatusCommand(parsed, getCommandContext());
      return;
    case "config":
      await runConfigCommand(parsed, getCommandContext());
      return;
    case "provider":
      await runProviderCommand(parsed, getCommandContext());
      return;
    case "document":
      await runDocumentCommand(parsed, getCommandContext());
      return;
    case "material":
      await runMaterialCommand(parsed, getCommandContext());
      return;
    case "index":
      await runIndexCommand(parsed, getCommandContext());
      return;
    case "search":
      await runSearchCommand(parsed, getCommandContext());
      return;
    case "embedding":
      await runEmbeddingCommand(parsed, getCommandContext());
      return;
    case "conversation":
      await runConversationCommand(parsed, getCommandContext());
      return;
    case "chat":
      await runChatCommand(parsed, getCommandContext());
      return;
    default:
      throw new AppError("VALIDATION_ERROR", `未知命令：${parsed.command}`);
  }
}

async function initializeApplication(): Promise<void> {
  const loaded = await initializeSoftwareConfig();
  commandContext = {
    appState,
    projectService: new ProjectService({ busyTimeoutMs: loaded.config.database.busyTimeoutMs }),
    input,
    output,
  };
  for (const warning of loaded.warnings) {
    output.write(`配置警告 [${warning.path}]：${warning.message}\n`);
  }
}

function getCommandContext(): CliCommandContext {
  if (commandContext === undefined) {
    throw new AppError("CONFIG_ERROR", "CLI 命令运行环境尚未初始化。");
  }
  return commandContext;
}

main(process.argv.slice(2)).catch((error: unknown) => {
  const appError = asAppError(error);
  process.stderr.write(`错误 [${appError.code}]：${appError.message}\n`);
  if (appError.details !== undefined) {
    process.stderr.write(`${JSON.stringify(appError.details, null, 2)}\n`);
  }
  process.exitCode = getExitCode(appError.code);
});
