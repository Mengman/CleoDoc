import type { ModelMessageSender, ModelProvider } from "../packages/contracts/src/index.js";

export function senderForProvider<T extends ModelProvider>(provider: T): T & ModelMessageSender {
  return Object.assign(provider, {
    send: ({ request }: Parameters<ModelMessageSender["send"]>[0], signal: AbortSignal) =>
      provider.stream(request, signal),
  });
}
