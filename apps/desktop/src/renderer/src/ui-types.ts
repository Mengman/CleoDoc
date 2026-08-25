import type { ReactNode } from "react";

export type NavigationId = "works" | "materials" | "settings";
export type CreativeSidebarId = Exclude<NavigationId, "settings">;

export interface NavigationItem {
  readonly id: NavigationId;
  readonly label: string;
  readonly icon: ReactNode;
}
