import { z } from "zod";

export const desktopChannels = {
  getRuntimeInfo: "desktop:get-runtime-info",
  showWindowMenu: "desktop:show-window-menu",
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

export type DesktopRuntimeInfo = z.infer<typeof desktopRuntimeInfoSchema>;
export type ShowWindowMenuInput = z.infer<typeof showWindowMenuInputSchema>;
export type WindowMenuId = z.infer<typeof windowMenuIdSchema>;

export interface CleoDocDesktopApi {
  readonly getRuntimeInfo: () => Promise<DesktopRuntimeInfo>;
  readonly showWindowMenu: (input: ShowWindowMenuInput) => Promise<void>;
}
