import { z } from "zod";

export const desktopChannels = {
  getRuntimeInfo: "desktop:get-runtime-info",
  showWindowMenu: "desktop:show-window-menu",
  getProjectState: "desktop:get-project-state",
  chooseAndOpenProject: "desktop:choose-and-open-project",
  closeProject: "desktop:close-project",
  projectStateChanged: "desktop:project-state-changed",
  listManuscriptDocuments: "desktop:list-manuscript-documents",
  readManuscriptDocument: "desktop:read-manuscript-document",
  getLlmApiSettings: "desktop:get-llm-api-settings",
  saveLlmApiSettings: "desktop:save-llm-api-settings",
  listConversations: "desktop:list-conversations",
  getConversationHistory: "desktop:get-conversation-history",
  sendChatMessage: "desktop:send-chat-message",
  chatMessageEvent: "desktop:chat-message-event",
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

export const manuscriptPathSchema = z
  .string()
  .regex(/^manuscript\/(?:[^/\\]+\/)*[^/\\]+\.(?:md|txt)$/i)
  .refine((value) => !value.split("/").some((segment) => segment === "." || segment === ".."));

export const manuscriptListResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("success"),
      documents: z.array(manuscriptPathSchema),
    })
    .strict(),
  z.object({ outcome: z.literal("error"), error: desktopOperationErrorSchema }).strict(),
]);

export const manuscriptReadResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("success"),
      relativePath: manuscriptPathSchema,
      content: z.string(),
    })
    .strict(),
  z.object({ outcome: z.literal("error"), error: desktopOperationErrorSchema }).strict(),
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

export const desktopConversationItemSchema = z
  .object({
    id: z.uuid(),
    title: z.string().nullable(),
  })
  .strict();

export const desktopConversationMessageSchema = z
  .object({
    id: z.uuid(),
    role: z.enum(["user", "assistant"]),
    content: z.string(),
    reasoningContent: z.string().optional(),
    sequence: z.number().int().nonnegative(),
    createdAt: z.iso.datetime(),
  })
  .strict();

const desktopUserMessageSchema = desktopConversationMessageSchema.extend({
  role: z.literal("user"),
});

const desktopAssistantMessageSchema = desktopConversationMessageSchema.extend({
  role: z.literal("assistant"),
});

export const getDesktopConversationHistoryInputSchema = z
  .object({ conversationId: z.uuid() })
  .strict();

export const sendDesktopChatMessageInputSchema = z
  .object({
    requestId: z.uuid(),
    conversationId: z.uuid(),
    prompt: z.string().trim().min(1).max(100_000),
  })
  .strict();

export const desktopChatMessageEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("reasoning-delta"),
      requestId: z.uuid(),
      conversationId: z.uuid(),
      text: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("reasoning-complete"),
      requestId: z.uuid(),
      conversationId: z.uuid(),
    })
    .strict(),
  z
    .object({
      type: z.literal("content-delta"),
      requestId: z.uuid(),
      conversationId: z.uuid(),
      text: z.string().min(1),
    })
    .strict(),
]);

export const desktopConversationListResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("success"),
      conversations: z.array(desktopConversationItemSchema),
    })
    .strict(),
  z.object({ outcome: z.literal("error"), error: desktopOperationErrorSchema }).strict(),
]);

export const desktopConversationHistoryResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("success"),
      conversation: desktopConversationItemSchema,
      messages: z.array(desktopConversationMessageSchema).max(20),
    })
    .strict(),
  z.object({ outcome: z.literal("error"), error: desktopOperationErrorSchema }).strict(),
]);

export const sendDesktopChatMessageResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("success"),
      conversation: desktopConversationItemSchema,
      messages: z.tuple([desktopUserMessageSchema, desktopAssistantMessageSchema]),
    })
    .strict(),
  z.object({ outcome: z.literal("error"), error: desktopOperationErrorSchema }).strict(),
]);

export type DesktopRuntimeInfo = z.infer<typeof desktopRuntimeInfoSchema>;
export type DesktopProjectState = z.infer<typeof desktopProjectStateSchema>;
export type DesktopProjectOperationResult = z.infer<typeof desktopProjectOperationResultSchema>;
export type ManuscriptListResult = z.infer<typeof manuscriptListResultSchema>;
export type ManuscriptReadResult = z.infer<typeof manuscriptReadResultSchema>;
export type ShowWindowMenuInput = z.infer<typeof showWindowMenuInputSchema>;
export type WindowMenuId = z.infer<typeof windowMenuIdSchema>;
export type DesktopLlmApiSettings = z.infer<typeof desktopLlmApiSettingsSchema>;
export type SaveDesktopLlmApiSettingsInput = z.infer<typeof saveDesktopLlmApiSettingsInputSchema>;
export type DesktopLlmApiSettingsResult = z.infer<typeof desktopLlmApiSettingsResultSchema>;
export type DesktopConversationItem = z.infer<typeof desktopConversationItemSchema>;
export type DesktopConversationMessage = z.infer<typeof desktopConversationMessageSchema>;
export type GetDesktopConversationHistoryInput = z.infer<
  typeof getDesktopConversationHistoryInputSchema
>;
export type SendDesktopChatMessageInput = z.infer<typeof sendDesktopChatMessageInputSchema>;
export type DesktopChatMessageEvent = z.infer<typeof desktopChatMessageEventSchema>;
export type DesktopConversationListResult = z.infer<typeof desktopConversationListResultSchema>;
export type DesktopConversationHistoryResult = z.infer<
  typeof desktopConversationHistoryResultSchema
>;
export type SendDesktopChatMessageResult = z.infer<typeof sendDesktopChatMessageResultSchema>;

export interface CleoDocDesktopApi {
  readonly getRuntimeInfo: () => Promise<DesktopRuntimeInfo>;
  readonly showWindowMenu: (input: ShowWindowMenuInput) => Promise<void>;
  readonly getProjectState: () => Promise<DesktopProjectState>;
  readonly chooseAndOpenProject: () => Promise<DesktopProjectOperationResult>;
  readonly closeProject: () => Promise<DesktopProjectOperationResult>;
  readonly onProjectStateChanged: (listener: (state: DesktopProjectState) => void) => () => void;
  readonly listManuscriptDocuments: () => Promise<ManuscriptListResult>;
  readonly readManuscriptDocument: (relativePath: string) => Promise<ManuscriptReadResult>;
  readonly getLlmApiSettings: () => Promise<DesktopLlmApiSettings>;
  readonly saveLlmApiSettings: (
    input: SaveDesktopLlmApiSettingsInput,
  ) => Promise<DesktopLlmApiSettingsResult>;
  readonly listConversations: () => Promise<DesktopConversationListResult>;
  readonly getConversationHistory: (
    input: GetDesktopConversationHistoryInput,
  ) => Promise<DesktopConversationHistoryResult>;
  readonly sendChatMessage: (
    input: SendDesktopChatMessageInput,
  ) => Promise<SendDesktopChatMessageResult>;
  readonly onChatMessageEvent: (listener: (event: DesktopChatMessageEvent) => void) => () => void;
}
