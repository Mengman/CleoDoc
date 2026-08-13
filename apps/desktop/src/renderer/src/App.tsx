import { useState, type ReactNode } from "react";

import { FeatureArea } from "./components/FeatureArea.js";
import { PrimaryNavigation } from "./components/PrimaryNavigation.js";
import { WindowTitlebar } from "./components/WindowTitlebar.js";
import { useDesktopState } from "./hooks/useDesktopState.js";
import type { NavigationId } from "./ui-types.js";

export function App(): ReactNode {
  // Compose the window chrome, global navigation, and active feature workspace.
  const [activeNavigation, setActiveNavigation] = useState<NavigationId>("works");
  const desktopState = useDesktopState();

  return (
    <div className="app-shell">
      <WindowTitlebar />
      <div className="app-body">
        <PrimaryNavigation activeNavigation={activeNavigation} onSelect={setActiveNavigation} />
        <FeatureArea
          activeNavigation={activeNavigation}
          projectState={desktopState.projectState}
          runtimeInfo={desktopState.runtimeInfo}
        />
      </div>
    </div>
  );
}
