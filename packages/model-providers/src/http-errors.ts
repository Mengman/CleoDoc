import { AppError } from "../../contracts/src/index.js";

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
    throw new AppError("PROVIDER_TIMEOUT", "模型服务请求超时。", { details });
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
): AppError {
  if (error instanceof AppError) {
    return error;
  }
  if (callerSignal?.aborted === true) {
    return new AppError("GENERATION_CANCELLED", "生成已取消。", { cause: error });
  }
  if (requestSignal.aborted) {
    return new AppError("PROVIDER_TIMEOUT", "模型服务请求超时。", { cause: error });
  }
  return new AppError("PROVIDER_UNAVAILABLE", "无法连接模型服务。", { cause: error });
}

export function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);
}
