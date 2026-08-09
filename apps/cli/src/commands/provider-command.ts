import { AppError } from "../../../../packages/contracts/src/index.js";
import { providerCatalog } from "../../../../packages/model-providers/src/index.js";
import { assertOnlyOptions, type ParsedArguments } from "../arguments.js";
import { providerFromArguments } from "./chat-settings.js";
import type { CliCommandContext } from "./command-context.js";
import { installInterruptHandler } from "./command-utils.js";

export async function runProviderCommand(
  parsed: ParsedArguments,
  context: CliCommandContext,
): Promise<void> {
  const [subcommand, providerId] = parsed.positionals;
  if (subcommand === "list") {
    assertOnlyOptions(parsed, []);
    for (const provider of providerCatalog) {
      context.output.write(
        `${provider.id}\t${provider.displayName}\t${provider.requiresApiKey ? "需要 CLEODOC_API_KEY" : "无需 API Key"}\n`,
      );
    }
    return;
  }
  if (subcommand !== "test" || providerId === undefined || parsed.positionals.length !== 2) {
    throw new AppError("VALIDATION_ERROR", "用法：cleo provider <list|test <provider>>");
  }
  assertOnlyOptions(parsed, [
    "base-url",
    "connect-timeout-ms",
    "stream-idle-timeout-ms",
    "generation-timeout-ms",
  ]);
  const provider = providerFromArguments(providerId, parsed);
  const controller = new AbortController();
  const removeHandler = installInterruptHandler(context, controller);
  try {
    const health = await provider.validateConfiguration(controller.signal);
    context.output.write(`${provider.displayName}：${health.message}\n`);
    for (const model of health.models ?? []) context.output.write(`  ${model}\n`);
  } finally {
    removeHandler();
  }
}
