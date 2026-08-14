import type { ReactNode } from "react";

import type { DesktopProjectState, DesktopRuntimeInfo } from "../../../../shared/desktop-api.js";
import type { CreativeSidebarId } from "../../ui-types.js";
import { ChatPanel } from "./ChatPanel.js";
import { DocumentWorkspace, type ManuscriptTab } from "./DocumentWorkspace.js";
import { MaterialsSidebar } from "./MaterialsSidebar.js";
import { WorksSidebar } from "./WorksSidebar.js";

export interface CreativeWorkspaceProps {
  readonly activeSidebar: CreativeSidebarId;
  readonly projectState: DesktopProjectState;
  readonly runtimeInfo: DesktopRuntimeInfo | null;
  readonly manuscriptTabs: readonly ManuscriptTab[];
  readonly activeManuscriptPath: string | null;
  readonly onOpenManuscript: (relativePath: string) => void;
  readonly onActivateManuscript: (relativePath: string) => void;
  readonly onCloseManuscript: (relativePath: string) => void;
}

export function CreativeWorkspace({
  activeSidebar,
  projectState,
  runtimeInfo,
  manuscriptTabs,
  activeManuscriptPath,
  onOpenManuscript,
  onActivateManuscript,
  onCloseManuscript,
}: CreativeWorkspaceProps): ReactNode {
  // Keep the document workspace and chat panel shared while switching only the left sidebar.
  // 1. Switch the feature-specific left sidebar without recreating the shared panels.
  // 2. Forward manuscript selection, activation, and closing to the shared tab state.
  // 3. Keep the chat panel bound to the current project session.
  return (
    <div className="creative-workspace">
      {activeSidebar === "works" ? (
        <WorksSidebar
          projectState={projectState}
          activeDocumentPath={activeManuscriptPath}
          onOpenDocument={onOpenManuscript}
        />
      ) : (
        <MaterialsSidebar />
      )}
      <DocumentWorkspace
        tabs={manuscriptTabs}
        activePath={activeManuscriptPath}
        runtimeInfo={runtimeInfo}
        onActivate={onActivateManuscript}
        onClose={onCloseManuscript}
      />
      <ChatPanel
        key={projectState.status === "open" ? projectState.project.id : "closed"}
        projectState={projectState}
      />
    </div>
  );
}
