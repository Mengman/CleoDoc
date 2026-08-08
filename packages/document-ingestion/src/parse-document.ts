import { IngestionCdmBuilder } from "./cdm-builder.js";
import { DocumentIngestionError } from "./errors.js";
import { parseMarkdownBlocks } from "./markdown-parser.js";
import { parseTextBlocks } from "./text-parser.js";
import type {
  ParsedDocument,
  ParseDocumentInput,
  ParseDocumentOptions,
  ParseWarning,
} from "./types.js";
import { Utf8Source } from "./utf8-source.js";

export const DOCUMENT_PARSER_VERSION = "document-ingestion-v1";

export function parseDocument(
  input: ParseDocumentInput,
  options: ParseDocumentOptions = {},
): ParsedDocument {
  if (input.format !== "text" && input.format !== "markdown") {
    throw new DocumentIngestionError(
      "UNSUPPORTED_DOCUMENT_FORMAT",
      `不支持资料格式：${String(input.format)}`,
    );
  }

  const source = Utf8Source.from(input.content);
  const builder = new IngestionCdmBuilder(options.randomSource);
  const warnings: ParseWarning[] = [];
  const blocks =
    input.format === "text"
      ? parseTextBlocks(source, builder)
      : parseMarkdownBlocks(source, builder, warnings);
  if (blocks.length === 0) {
    warnings.push({
      code: "NO_VISIBLE_CONTENT",
      message: "资料中没有可解析的可见文字。",
    });
  }
  const result = builder.finish(blocks, source.byteLength);
  return {
    format: input.format,
    parserVersion: DOCUMENT_PARSER_VERSION,
    status: warnings.length === 0 ? "ok" : "partial",
    sourceByteLength: source.byteLength,
    ...result,
    warnings,
  };
}
