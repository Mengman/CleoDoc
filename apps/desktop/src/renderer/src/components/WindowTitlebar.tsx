import type { MouseEvent, ReactNode } from "react";

import type { DesktopProjectState, WindowMenuId } from "../../../shared/desktop-api.js";

const windowMenus: ReadonlyArray<{ id: WindowMenuId; label: string }> = [
  { id: "file", label: "File" },
  { id: "edit", label: "Edit" },
  { id: "view", label: "View" },
  { id: "appearance", label: "外观" },
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

export function WindowTitlebar({
  projectState,
}: {
  readonly projectState: DesktopProjectState;
}): ReactNode {
  // Render the software logo, menus, and current project folder inside the native title bar.
  // 1. Keep the logo and application menus inside the safe overlay area.
  // 2. Delegate minimize, maximize, and close controls to Electron's native title-bar overlay.
  return (
    <header className="relative col-span-full row-start-1 min-w-0 select-none border-b border-border bg-surface [app-region:drag]">
      <div className="absolute inset-y-0 flex min-w-0 items-center px-2 [left:env(titlebar-area-x,0px)] [width:env(titlebar-area-width,100%)]">
        <div
          className="mr-[5px] grid size-[25px] flex-none content-center gap-0.5 rounded-[7px] bg-gradient-to-br from-primary to-primary/80"
          aria-label="CleoDoc"
        >
          <span className="mx-auto block h-0.5 w-3 rounded-sm bg-primary-foreground" />
          <span className="mx-auto block h-0.5 w-3 rounded-sm bg-primary-foreground" />
          <span className="mx-auto block h-0.5 w-3 rounded-sm bg-primary-foreground" />
        </div>
        <nav className="flex self-stretch [app-region:no-drag]" aria-label="应用菜单">
          {windowMenus.map((menu) => (
            <button
              key={menu.id}
              className="rounded-[5px] bg-transparent px-[9px] text-xs text-muted-foreground hover:bg-surface-raised hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              type="button"
              onClick={(event) => showWindowMenu(event, menu.id)}
            >
              {menu.label}
            </button>
          ))}
        </nav>
        <div className="absolute left-1/2 max-w-[42%] -translate-x-1/2 overflow-hidden text-ellipsis whitespace-nowrap text-xs text-muted-foreground max-[900px]:hidden">
          {projectState.status === "open" ? projectState.project.folderName : "CleoDoc"}
        </div>
      </div>
    </header>
  );
}
