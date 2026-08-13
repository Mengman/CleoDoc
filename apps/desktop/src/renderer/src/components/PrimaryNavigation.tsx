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
      className={activeNavigation === item.id ? "rail-item active" : "rail-item"}
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
    <nav className="primary-navigation rail" aria-label="主导航">
      <div className="rail-items">
        {workspaceItems.map((item) => (
          <NavigationButton key={item.id} item={item} {...props} />
        ))}
      </div>
      <div className="rail-items rail-bottom">
        <NavigationButton item={settingsItem} {...props} />
      </div>
    </nav>
  );
}
