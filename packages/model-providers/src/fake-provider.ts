import type {
  ModelEvent,
  ModelProvider,
  ModelRequest,
  ProviderHealth,
} from "../../contracts/src/index.js";
import { AppError } from "../../contracts/src/index.js";

export class FakeModelProvider implements ModelProvider {
  readonly id = "fake";
  readonly displayName = "Fake Provider (tests only)";

  constructor(private readonly response: string) {}

  async validateConfiguration(): Promise<ProviderHealth> {
    return { ok: true, message: "Fake Provider ready.", models: ["fake-model"] };
  }

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    if (signal.aborted) {
      throw new AppError("GENERATION_CANCELLED", "生成已取消。");
    }
    const middle = Math.ceil(this.response.length / 2);
    yield { type: "text-delta", text: this.response.slice(0, middle) };
    yield { type: "text-delta", text: this.response.slice(middle) };
    yield {
      type: "usage",
      usage: { inputTokens: request.messages.length * 10, outputTokens: this.response.length },
    };
    yield { type: "done", finishReason: "stop" };
  }
}
