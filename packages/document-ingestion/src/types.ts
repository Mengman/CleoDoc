import type { CdmDocument, CdmRandomBytes } from "@cleodoc/cdm";

export type IngestionDocumentFormat = "text" | "markdown";

export interface ParseDocumentInput {
  readonly format: IngestionDocumentFormat;
  readonly content: string | Uint8Array;
}

export interface ParseDocumentOptions {
  readonly randomSource?: CdmRandomBytes;
}

export type ParseWarningCode =
  | "NO_VISIBLE_CONTENT"
  | "RAW_HTML_PRESERVED_AS_TEXT"
  | "IMAGE_REDUCED_TO_ALT_TEXT"
  | "UNRESOLVED_LINK_REFERENCE"
  | "CODE_METADATA_DROPPED"
  | "UNSUPPORTED_MARKDOWN_PRESERVED_AS_TEXT";

export interface ParseWarning {
  readonly code: ParseWarningCode;
  readonly message: string;
  readonly startOffset?: number;
  readonly endOffset?: number;
}

export interface CdmNodeSourceRange {
  readonly nodeId: string;
  readonly startOffset: number;
  readonly endOffset: number;
}

export interface ParsedDocument {
  readonly format: IngestionDocumentFormat;
  readonly parserVersion: string;
  readonly status: "ok" | "partial";
  readonly sourceByteLength: number;
  readonly cdm: CdmDocument;
  readonly cdmXml: string;
  readonly nodeRanges: readonly CdmNodeSourceRange[];
  readonly warnings: readonly ParseWarning[];
}

export interface SourceRange {
  readonly startOffset: number;
  readonly endOffset: number;
}
