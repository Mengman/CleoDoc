import type { MouseEvent, ReactNode } from "react";

import type { WindowMenuId } from "../../../shared/desktop-api.js";

const windowMenus: ReadonlyArray<{ id: WindowMenuId; label: string }> = [
  { id: "file", label: "File" },
  { id: "edit", label: "Edit" },
  { id: "view", label: "View" },
  { id: "window", label: "Window" },
];

function showWindowMenu(event: MouseEvent<HTMLButtonElement>, menuId: WindowMenuId): void {
  // Anchor the requested native menu below its title-bar button.
  const bounds = event.currentTarget.getBoundingClientRect();
  void window.cleodoc.showWindowMenu({
    menuId,
    x: Math.round(bounds.left),
    y: Math.round(bounds.bottom),
  });
}

export function WindowTitlebar(): ReactNode {
  // Render the software logo and menus inside the native window title bar.
  // 1. Keep the logo and application menus inside the safe overlay area.
  // 2. Delegate minimize, maximize, and close controls to Electron's native title-bar overlay.
  return (
    <header className="window-titlebar">
      <div className="window-titlebar-safe">
        <div className="window-app-mark" aria-label="CleoDoc">
          <span />
          <span />
          <span />
        </div>
        <nav className="window-menu" aria-label="应用菜单">
          {windowMenus.map((menu) => (
            <button key={menu.id} type="button" onClick={(event) => showWindowMenu(event, menu.id)}>
              {menu.label}
            </button>
          ))}
        </nav>
        <div className="window-title">CleoDoc</div>
      </div>
    </header>
  );
}
