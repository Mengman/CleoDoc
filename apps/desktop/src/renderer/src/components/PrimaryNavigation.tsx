import {
  Archive as ArchiveIcon,
  FileText as DocumentIcon,
  Settings as SettingsIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import type { NavigationId, NavigationItem } from "../ui-types.js";

const workspaceItems: readonly NavigationItem[] = [
  { id: "works", label: "作品", icon: <DocumentIcon /> },
  { id: "materials", label: "资料", icon: <ArchiveIcon /> },
];

const settingsItem: NavigationItem = {
  id: "settings",
  label: "设置",
  icon: <SettingsIcon />,
};

export interface PrimaryNavigationProps {
  readonly activeNavigation: NavigationId;
  readonly onSelect: (navigation: NavigationId) => void;
}

function NavigationButton({
  item,
  activeNavigation,
  onSelect,
}: PrimaryNavigationProps & { readonly item: NavigationItem }): ReactNode {
  // Render one global navigation action and indicate its selected feature.
  return (
    <button
      className={
        activeNavigation === item.id
          ? "relative grid justify-items-center gap-[5px] rounded-[10px] bg-accent px-1 py-2.5 text-[10px] text-accent-foreground transition-colors before:absolute before:-left-2 before:bottom-3 before:top-3 before:w-[3px] before:rounded-[3px] before:bg-primary [&>svg]:size-[22px]"
          : "grid justify-items-center gap-[5px] rounded-[10px] px-1 py-2.5 text-[10px] text-muted-foreground transition-colors hover:bg-surface-raised hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&>svg]:size-[22px]"
      }
      type="button"
      onClick={() => onSelect(item.id)}
      aria-current={activeNavigation === item.id ? "page" : undefined}
    >
      {item.icon}
      <span>{item.label}</span>
    </button>
  );
}

export function PrimaryNavigation(props: PrimaryNavigationProps): ReactNode {
  // Render workspace navigation at the top and settings at the bottom.
  return (
    <nav
      className="primary-navigation flex flex-col justify-between border-r border-border bg-surface"
      aria-label="主导航"
    >
      <div className="grid gap-2 px-2 py-4">
        {workspaceItems.map((item) => (
          <NavigationButton key={item.id} item={item} {...props} />
        ))}
      </div>
      <div className="grid gap-2 px-2 pb-4 pt-2">
        <NavigationButton item={settingsItem} {...props} />
      </div>
    </nav>
  );
}
