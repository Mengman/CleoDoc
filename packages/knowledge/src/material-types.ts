import type { ChunkDocumentOptions } from "@cleodoc/document-ingestion";
import type { MaterialInputEncoding } from "./text-decoding.js";

interface MaterialMetadataOptions {
  title?: string;
  sourceLabel?: string;
  tags?: readonly string[];
}

export interface AddFileMaterialOptions extends MaterialMetadataOptions {
  encoding?: MaterialInputEncoding;
}

export interface AddTextMaterialOptions extends MaterialMetadataOptions {
  format?: "text" | "markdown";
}

export interface MaterialServiceOptions {
  readonly database: { busyTimeoutMs: number };
  readonly maxImportBytes: number;
  readonly chunking: ChunkDocumentOptions;
}
