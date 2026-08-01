import { AppError } from "../../contracts/src/index.js";

export type ProviderTimeoutKind = "connection" | "stream_idle" | "overall";

export interface ProviderStreamTimeoutOptions {
  connectionTimeoutMs: number;
  streamIdleTimeoutMs: number;
  overallTimeoutMs: number;
}

export interface ProviderStreamTimeoutOverrides {
  connectionTimeoutMs?: number;
  streamIdleTimeoutMs?: number;
  overallTimeoutMs?: number;
  /** @deprecated Use overallTimeoutMs. */
  timeoutMs?: number;
}

export const DEFAULT_PROVIDER_STREAM_TIMEOUTS: ProviderStreamTimeoutOptions = {
  connectionTimeoutMs: 60_000,
  streamIdleTimeoutMs: 120_000,
  overallTimeoutMs: 20 * 60_000,
};

export function resolveProviderStreamTimeouts(
  overrides: ProviderStreamTimeoutOverrides,
): ProviderStreamTimeoutOptions {
  return {
    connectionTimeoutMs:
      overrides.connectionTimeoutMs ?? DEFAULT_PROVIDER_STREAM_TIMEOUTS.connectionTimeoutMs,
    streamIdleTimeoutMs:
      overrides.streamIdleTimeoutMs ?? DEFAULT_PROVIDER_STREAM_TIMEOUTS.streamIdleTimeoutMs,
    overallTimeoutMs:
      overrides.overallTimeoutMs ??
      overrides.timeoutMs ??
      DEFAULT_PROVIDER_STREAM_TIMEOUTS.overallTimeoutMs,
  };
}

export async function throwForProviderResponse(response: Response): Promise<never> {
  const responseText = await response.text().catch(() => "");
  const details = { status: response.status, response: responseText.slice(0, 500) };
  if (response.status === 401 || response.status === 403) {
    throw new AppError("PROVIDER_AUTH_ERROR", "模型服务鉴权失败，请检查 API Key。", {
      details,
    });
  }
  if (response.status === 429) {
    throw new AppError("PROVIDER_RATE_LIMITED", "模型服务限流或额度不足。", { details });
  }
  if (response.status === 408 || response.status === 504) {
    throw new AppError("PROVIDER_TIMEOUT", "上游模型服务请求超时。", {
      details: { ...details, timeoutKind: "upstream" },
    });
  }
  if (/context|token.{0,20}(limit|maximum)|maximum context/i.test(responseText)) {
    throw new AppError("PROVIDER_CONTEXT_LIMIT", "请求超过了模型上下文限制。", { details });
  }
  throw new AppError("PROVIDER_UNAVAILABLE", `模型服务返回 HTTP ${response.status}。`, {
    details,
  });
}

export function mapProviderFailure(
  error: unknown,
  callerSignal: AbortSignal | undefined,
  requestSignal: AbortSignal,
  timeoutKind?: ProviderTimeoutKind | null,
): AppError {
  if (error instanceof AppError) {
    return error;
  }
  if (callerSignal?.aborted === true) {
    return new AppError("GENERATION_CANCELLED", "生成已取消。", { cause: error });
  }
  if (timeoutKind !== undefined && timeoutKind !== null) {
    return new AppError("PROVIDER_TIMEOUT", timeoutMessage(timeoutKind), {
      cause: error,
      details: { timeoutKind },
    });
  }
  if (requestSignal.aborted) {
    return new AppError("PROVIDER_TIMEOUT", "模型服务请求超时。", { cause: error });
  }
  return new AppError("PROVIDER_UNAVAILABLE", "无法连接模型服务。", { cause: error });
}

export class ProviderStreamTimeoutController {
  readonly signal: AbortSignal;
  timeoutKind: ProviderTimeoutKind | null = null;

  private readonly timeoutController = new AbortController();
  private connectionTimer: NodeJS.Timeout | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  private overallTimer: NodeJS.Timeout | undefined;

  constructor(
    callerSignal: AbortSignal,
    private readonly options: ProviderStreamTimeoutOptions,
  ) {
    assertPositiveTimeout("连接超时", options.connectionTimeoutMs);
    assertPositiveTimeout("流空闲超时", options.streamIdleTimeoutMs);
    assertPositiveTimeout("总生成超时", options.overallTimeoutMs);
    this.signal = AbortSignal.any([callerSignal, this.timeoutController.signal]);
    this.connectionTimer = this.startTimer("connection", options.connectionTimeoutMs);
    this.overallTimer = this.startTimer("overall", options.overallTimeoutMs);
  }

  markConnected(): void {
    clearTimeout(this.connectionTimer);
    this.connectionTimer = undefined;
    this.markActivity();
  }

  markActivity(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = this.startTimer("stream_idle", this.options.streamIdleTimeoutMs);
  }

  dispose(): void {
    clearTimeout(this.connectionTimer);
    clearTimeout(this.idleTimer);
    clearTimeout(this.overallTimer);
    this.connectionTimer = undefined;
    this.idleTimer = undefined;
    this.overallTimer = undefined;
  }

  private startTimer(kind: ProviderTimeoutKind, delay: number): NodeJS.Timeout {
    const timer = setTimeout(() => {
      if (this.timeoutKind === null && !this.timeoutController.signal.aborted) {
        this.timeoutKind = kind;
        this.timeoutController.abort(new DOMException(timeoutMessage(kind), "TimeoutError"));
      }
    }, delay);
    timer.unref();
    return timer;
  }
}

export function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);
}

function assertPositiveTimeout(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new AppError("VALIDATION_ERROR", `${label}必须是正整数毫秒数。`);
  }
}

function timeoutMessage(kind: ProviderTimeoutKind): string {
  switch (kind) {
    case "connection":
      return "连接模型服务或等待首个响应超时。";
    case "stream_idle":
      return "模型响应流长时间没有返回新数据。";
    case "overall":
      return "本轮模型生成超过总时间限制。";
  }
}
