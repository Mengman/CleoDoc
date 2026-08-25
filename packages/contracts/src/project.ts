import { z } from "zod";

export const PROJECT_SCHEMA_VERSION = 1 as const;

export const projectManifestSchema = z.object({
  schemaVersion: z.literal(PROJECT_SCHEMA_VERSION),
  id: z.uuid(),
  name: z.string().trim().min(1).max(200),
  language: z.literal("zh-CN"),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type ProjectManifest = z.infer<typeof projectManifestSchema>;

export interface ProjectStatus {
  root: string;
  manifest: ProjectManifest;
  database: "ok" | "corrupt";
  documentCount: number;
}

export interface DocumentSummary {
  relativePath: string;
  contentHash: string;
  size: number;
  updatedAt: string;
}

export interface SavedDocument extends DocumentSummary {
  created: boolean;
}
