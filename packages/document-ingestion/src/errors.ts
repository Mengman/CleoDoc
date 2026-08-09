export type DocumentIngestionErrorCode =
  | "UNSUPPORTED_DOCUMENT_FORMAT"
  | "INVALID_UTF8"
  | "EMPTY_DOCUMENT"
  | "INVALID_SOURCE_POSITION"
  | "INVALID_CHUNK_OPTIONS";

export class DocumentIngestionError extends Error {
  readonly code: DocumentIngestionErrorCode;
  override readonly cause?: unknown;

  constructor(code: DocumentIngestionErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "DocumentIngestionError";
    this.code = code;
    this.cause = cause;
  }
}
