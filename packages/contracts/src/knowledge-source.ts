import { z } from "zod";

export const KNOWLEDGE_SOURCE_SCHEMA_VERSION = 1 as const;

export const knowledgeSourceSchema = z.object({
  schemaVersion: z.literal(KNOWLEDGE_SOURCE_SCHEMA_VERSION),
  id: z.uuid(),
  projectId: z.uuid(),
  type: z.literal("material"),
  origin: z.enum(["file", "paste"]),
  format: z.enum(["text", "markdown"]),
  title: z.string().trim().min(1).max(200),
  sourceLabel: z.string().trim().min(1).max(2_000).nullable(),
  originalFileName: z.string().trim().min(1).max(500).nullable(),
  tags: z.array(z.string().trim().min(1).max(100)).max(100),
  relativePath: z.string().regex(/^materials\/[0-9a-f-]+\.(txt|md)$/),
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  size: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type KnowledgeSource = z.infer<typeof knowledgeSourceSchema>;

export interface MaterialWithContent {
  source: KnowledgeSource;
  content: string;
}

export interface MaterialImportResult {
  source: KnowledgeSource;
  created: boolean;
}
