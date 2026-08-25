import { useState, type ReactNode } from "react";

import { FeatureArea } from "./components/FeatureArea.js";
import { PrimaryNavigation } from "./components/PrimaryNavigation.js";
import { StatusBar } from "./components/StatusBar.js";
import { WindowTitlebar } from "./components/WindowTitlebar.js";
import { useDesktopState } from "./hooks/useDesktopState.js";
import type { NavigationId } from "./ui-types.js";

export function App(): ReactNode {
  // Compose the window chrome, global navigation, and active feature workspace.
  const [activeNavigation, setActiveNavigation] = useState<NavigationId>("works");
  const desktopState = useDesktopState();

  return (
    <div className="app-shell grid size-full min-w-[1120px] grid-rows-[40px_minmax(0,1fr)_22px] bg-background text-foreground">
      <WindowTitlebar projectState={desktopState.projectState} />
      <div className="app-body grid min-h-0 min-w-0 grid-cols-[68px_minmax(0,1fr)]">
        <PrimaryNavigation activeNavigation={activeNavigation} onSelect={setActiveNavigation} />
        <FeatureArea activeNavigation={activeNavigation} projectState={desktopState.projectState} />
      </div>
      <StatusBar />
    </div>
  );
}
