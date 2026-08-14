import { AppError } from "../../../../packages/contracts/src/index.js";
import { providerCatalog } from "../../../../packages/model-providers/src/index.js";
import { assertOnlyOptions, type ParsedArguments } from "../arguments.js";
import { getSoftwareConfig } from "../../../../packages/config/src/index.js";
import { providerServiceFromArguments } from "./chat-settings.js";
import type { CliCommandContext } from "./command-context.js";
import { installInterruptHandler } from "./command-utils.js";

export async function runProviderCommand(
  parsed: ParsedArguments,
  context: CliCommandContext,
): Promise<void> {
  // List known Providers or test one through the shared ProviderService boundary.
  // 1. Handle the read-only catalog listing without constructing a Provider.
  // 2. Resolve a temporary model identity and command-scoped connection options.
  // 3. Validate the effective Provider and print only its public health response.
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
  const config = getSoftwareConfig();
  const modelId = Object.keys(config.llm.providers[providerId]?.models ?? {})[0] ?? "provider-test";
  const provider = providerServiceFromArguments(providerId, modelId, parsed);
  const controller = new AbortController();
  const removeHandler = installInterruptHandler(context, controller);
  try {
    const health = await provider.validateCurrentConfiguration(controller.signal);
    const info = await provider.getCurrentInfo();
    context.output.write(`${info.providerName}：${health.message}\n`);
    for (const model of health.models ?? []) context.output.write(`  ${model}\n`);
  } finally {
    removeHandler();
  }
}
