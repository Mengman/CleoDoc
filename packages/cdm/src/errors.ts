import type { CdmValidationIssue } from "./types.js";

export type CdmErrorCode = "CDM_XML_INVALID" | "CDM_SCHEMA_INVALID" | "CDM_ID_GENERATION_FAILED";

export class CdmError extends Error {
  readonly code: CdmErrorCode;
  readonly issues?: readonly CdmValidationIssue[];
  override readonly cause?: unknown;

  constructor(
    code: CdmErrorCode,
    message: string,
    options: { cause?: unknown; issues?: readonly CdmValidationIssue[] } = {},
  ) {
    super(message);
    this.name = "CdmError";
    this.code = code;
    this.cause = options.cause;
    this.issues = options.issues;
  }
}
