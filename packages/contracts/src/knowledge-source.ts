import { z } from "zod";

export const KNOWLEDGE_SOURCE_SCHEMA_VERSION = 1 as const;

export const knowledgeSourceLanguageSchema = z.enum(["zh", "en"]);

export const knowledgeSourceSchema = z.object({
  schemaVersion: z.literal(KNOWLEDGE_SOURCE_SCHEMA_VERSION),
  id: z.uuid(),
  projectId: z.uuid(),
  type: z.literal("material"),
  origin: z.enum(["file", "paste"]),
  format: z.enum(["text", "markdown"]),
  title: z.string().trim().min(1).max(200),
  originalFileName: z.string().trim().min(1).max(500).nullable(),
  languages: z
    .array(knowledgeSourceLanguageSchema)
    .min(1)
    .max(2)
    .refine((languages) => new Set(languages).size === languages.length)
    .default(["zh"]),
  relativePath: z.string().regex(/^materials\/[^/\\]+\.(txt|md|markdown)$/i),
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  size: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type KnowledgeSource = z.infer<typeof knowledgeSourceSchema>;
export type KnowledgeSourceLanguage = z.infer<typeof knowledgeSourceLanguageSchema>;

export interface MaterialWithContent {
  source: KnowledgeSource;
  content: string;
}

export interface MaterialImportResult {
  source: KnowledgeSource;
  created: boolean;
  inputEncoding: "utf-8" | "gb18030";
}
