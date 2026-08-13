import type { ReactNode } from "react";

import type { DesktopProjectState, DesktopRuntimeInfo } from "../../../../shared/desktop-api.js";
import type { CreativeSidebarId } from "../../ui-types.js";
import { ChatPanel } from "./ChatPanel.js";
import { DocumentWorkspace } from "./DocumentWorkspace.js";
import { MaterialsSidebar } from "./MaterialsSidebar.js";
import { WorksSidebar } from "./WorksSidebar.js";

export interface CreativeWorkspaceProps {
  readonly activeSidebar: CreativeSidebarId;
  readonly projectState: DesktopProjectState;
  readonly runtimeInfo: DesktopRuntimeInfo | null;
}

export function CreativeWorkspace({
  activeSidebar,
  projectState,
  runtimeInfo,
}: CreativeWorkspaceProps): ReactNode {
  // Keep the document workspace and chat panel shared while switching only the left sidebar.
  return (
    <div className="creative-workspace">
      {activeSidebar === "works" ? (
        <WorksSidebar projectState={projectState} />
      ) : (
        <MaterialsSidebar projectState={projectState} />
      )}
      <DocumentWorkspace runtimeInfo={runtimeInfo} />
      <ChatPanel />
    </div>
  );
}
