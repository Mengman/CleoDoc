import { z } from "zod";

export const desktopChannels = {
  getRuntimeInfo: "desktop:get-runtime-info",
  showWindowMenu: "desktop:show-window-menu",
  getProjectState: "desktop:get-project-state",
  chooseAndOpenProject: "desktop:choose-and-open-project",
  closeProject: "desktop:close-project",
  projectStateChanged: "desktop:project-state-changed",
  getLlmApiSettings: "desktop:get-llm-api-settings",
  saveLlmApiSettings: "desktop:save-llm-api-settings",
} as const;

export const windowMenuIdSchema = z.enum(["file", "edit", "view", "window"]);

export const showWindowMenuInputSchema = z
  .object({
    menuId: windowMenuIdSchema,
    x: z.number().int().min(0).max(10_000),
    y: z.number().int().min(0).max(10_000),
  })
  .strict();

export const desktopRuntimeInfoSchema = z
  .object({
    appVersion: z.string().min(1),
    electronVersion: z.string().min(1),
    nodeVersion: z.string().min(1),
    platform: z.string().min(1),
  })
  .strict();

export const desktopProjectSummarySchema = z
  .object({
    id: z.uuid(),
    name: z.string().trim().min(1),
    language: z.string().trim().min(1),
    documentCount: z.number().int().nonnegative(),
    database: z.literal("ok"),
  })
  .strict();

export const desktopProjectStateSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("closed") }).strict(),
  z
    .object({
      status: z.literal("open"),
      project: desktopProjectSummarySchema,
    })
    .strict(),
]);

export const desktopOperationErrorSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
  })
  .strict();

export const desktopProjectOperationResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("success"),
      state: desktopProjectStateSchema,
    })
    .strict(),
  z
    .object({
      outcome: z.literal("cancelled"),
      state: desktopProjectStateSchema,
    })
    .strict(),
  z
    .object({
      outcome: z.literal("error"),
      state: desktopProjectStateSchema,
      error: desktopOperationErrorSchema,
    })
    .strict(),
]);

export const desktopLlmApiSettingsSchema = z
  .object({
    baseUrl: z.url(),
    modelName: z.literal("deepseek-v4-flash"),
    apiKeyConfigured: z.boolean(),
    apiKeyLength: z.number().int().positive().max(4_096).nullable(),
    secureStorageAvailable: z.boolean(),
  })
  .strict();

export const saveDesktopLlmApiSettingsInputSchema = z
  .object({
    baseUrl: z.url(),
    modelName: z.literal("deepseek-v4-flash"),
    apiKey: z.string().trim().min(1).optional(),
  })
  .strict();

export const desktopLlmApiSettingsResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("success"), settings: desktopLlmApiSettingsSchema }).strict(),
  z.object({ outcome: z.literal("error"), error: desktopOperationErrorSchema }).strict(),
]);

export type DesktopRuntimeInfo = z.infer<typeof desktopRuntimeInfoSchema>;
export type DesktopProjectState = z.infer<typeof desktopProjectStateSchema>;
export type DesktopProjectOperationResult = z.infer<typeof desktopProjectOperationResultSchema>;
export type ShowWindowMenuInput = z.infer<typeof showWindowMenuInputSchema>;
export type WindowMenuId = z.infer<typeof windowMenuIdSchema>;
export type DesktopLlmApiSettings = z.infer<typeof desktopLlmApiSettingsSchema>;
export type SaveDesktopLlmApiSettingsInput = z.infer<typeof saveDesktopLlmApiSettingsInputSchema>;
export type DesktopLlmApiSettingsResult = z.infer<typeof desktopLlmApiSettingsResultSchema>;

export interface CleoDocDesktopApi {
  readonly getRuntimeInfo: () => Promise<DesktopRuntimeInfo>;
  readonly showWindowMenu: (input: ShowWindowMenuInput) => Promise<void>;
  readonly getProjectState: () => Promise<DesktopProjectState>;
  readonly chooseAndOpenProject: () => Promise<DesktopProjectOperationResult>;
  readonly closeProject: () => Promise<DesktopProjectOperationResult>;
  readonly onProjectStateChanged: (listener: (state: DesktopProjectState) => void) => () => void;
  readonly getLlmApiSettings: () => Promise<DesktopLlmApiSettings>;
  readonly saveLlmApiSettings: (
    input: SaveDesktopLlmApiSettingsInput,
  ) => Promise<DesktopLlmApiSettingsResult>;
}
