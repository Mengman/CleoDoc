export const appErrorCodes = [
  "VALIDATION_ERROR",
  "PROJECT_NOT_FOUND",
  "PROJECT_ALREADY_EXISTS",
  "PATH_OUTSIDE_PROJECT",
  "DOCUMENT_NOT_FOUND",
  "DOCUMENT_ALREADY_EXISTS",
  "HISTORY_MESSAGE_NOT_FOUND",
  "MATERIAL_NOT_FOUND",
  "MATERIAL_ALREADY_EXISTS",
  "EMBEDDING_MODEL_NOT_FOUND",
  "EMBEDDING_MODEL_LOAD_FAILED",
  "EMBEDDING_GENERATION_FAILED",
  "EMBEDDING_INPUT_TOO_LONG",
  "EMBEDDING_TASK_CANCELLED",
  "VECTOR_INDEX_UNAVAILABLE",
  "CONFIG_ERROR",
  "DATABASE_ERROR",
  "PROVIDER_AUTH_ERROR",
  "PROVIDER_RATE_LIMITED",
  "PROVIDER_CONTEXT_LIMIT",
  "PROVIDER_TIMEOUT",
  "PROVIDER_UNAVAILABLE",
  "COMPACTION_EMPTY_SUMMARY",
  "COMPACTION_TRUNCATED",
  "COMPACTION_SUMMARY_TOO_LARGE",
  "COMPACTION_TOOL_CALL_NOT_ALLOWED",
  "GENERATION_CANCELLED",
  "GENERATION_NOT_FOUND",
  "TOOL_EXECUTION_FAILED",
  "IO_ERROR",
  "INTERNAL_ERROR",
] as const;

export type AppErrorCode = (typeof appErrorCodes)[number];

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;
  override readonly cause?: unknown;

  constructor(
    code: AppErrorCode,
    message: string,
    options: { cause?: unknown; details?: Readonly<Record<string, unknown>> } = {},
  ) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.cause = options.cause;
    this.details = options.details;
  }
}

export function asAppError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error;
  }

  return new AppError("INTERNAL_ERROR", "发生未预期的内部错误。", { cause: error });
}

export function getExitCode(code: AppErrorCode): number {
  switch (code) {
    case "VALIDATION_ERROR":
      return 2;
    case "PROJECT_NOT_FOUND":
    case "DOCUMENT_NOT_FOUND":
    case "MATERIAL_NOT_FOUND":
    case "EMBEDDING_MODEL_NOT_FOUND":
    case "GENERATION_NOT_FOUND":
      return 3;
    case "PROJECT_ALREADY_EXISTS":
    case "DOCUMENT_ALREADY_EXISTS":
    case "MATERIAL_ALREADY_EXISTS":
      return 4;
    case "PROVIDER_AUTH_ERROR":
      return 5;
    case "PROVIDER_RATE_LIMITED":
      return 6;
    case "PROVIDER_TIMEOUT":
      return 7;
    case "GENERATION_CANCELLED":
    case "EMBEDDING_TASK_CANCELLED":
      return 130;
    default:
      return 1;
  }
}
