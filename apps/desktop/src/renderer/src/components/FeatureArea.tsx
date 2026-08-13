import type { ReactNode } from "react";

import type { DesktopProjectState, DesktopRuntimeInfo } from "../../../shared/desktop-api.js";
import type { NavigationId } from "../ui-types.js";
import { CreativeWorkspace } from "./creative/CreativeWorkspace.js";
import { SettingsWorkspace } from "./settings/SettingsWorkspace.js";

export interface FeatureAreaProps {
  readonly activeNavigation: NavigationId;
  readonly projectState: DesktopProjectState;
  readonly runtimeInfo: DesktopRuntimeInfo | null;
}

export function FeatureArea({
  activeNavigation,
  projectState,
  runtimeInfo,
}: FeatureAreaProps): ReactNode {
  // Switch between the full settings workspace and the shared creative workspace.
  return (
    <section className="feature-area">
      {activeNavigation === "settings" ? (
        <SettingsWorkspace />
      ) : (
        <CreativeWorkspace
          activeSidebar={activeNavigation}
          projectState={projectState}
          runtimeInfo={runtimeInfo}
        />
      )}
    </section>
  );
}
