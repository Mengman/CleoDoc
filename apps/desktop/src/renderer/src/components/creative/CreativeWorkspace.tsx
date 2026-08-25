import type { ReactNode } from "react";

import type { DesktopProjectState } from "../../../../shared/desktop-api.js";
import type { CreativeSidebarId } from "../../ui-types.js";
import { ChatPanel } from "./ChatPanel.js";
import { DocumentWorkspace, documentTabKey, type DocumentTab } from "./DocumentWorkspace.js";
import { MaterialsSidebar } from "./MaterialsSidebar.js";
import { WorksSidebar } from "./WorksSidebar.js";

export interface CreativeWorkspaceProps {
  readonly activeSidebar: CreativeSidebarId;
  readonly projectState: DesktopProjectState;
  readonly documentTabs: readonly DocumentTab[];
  readonly activeDocumentTabKey: string | null;
  readonly onOpenManuscript: (relativePath: string) => void;
  readonly onOpenMaterial: (title: string) => void;
  readonly onRenameMaterial: (title: string, newTitle: string) => Promise<boolean>;
  readonly onDeleteMaterial: (title: string) => Promise<boolean>;
  readonly onActivateDocument: (tab: DocumentTab) => void;
  readonly onCloseDocument: (tab: DocumentTab) => void;
}

export function CreativeWorkspace({
  activeSidebar,
  projectState,
  documentTabs,
  activeDocumentTabKey,
  onOpenManuscript,
  onOpenMaterial,
  onRenameMaterial,
  onDeleteMaterial,
  onActivateDocument,
  onCloseDocument,
}: CreativeWorkspaceProps): ReactNode {
  // Keep the document workspace and chat panel shared while switching only the left sidebar.
  // 1. Switch the feature-specific left sidebar without recreating the shared panels.
  // 2. Forward manuscript and material selection, activation, and closing to shared tab state.
  // 3. Keep the chat panel bound to the current project session.
  return (
    <div className="grid size-full min-h-0 min-w-0 grid-cols-[292px_minmax(480px,1fr)_370px] overflow-hidden max-[1320px]:grid-cols-[260px_minmax(430px,1fr)_330px]">
      {activeSidebar === "works" ? (
        <WorksSidebar
          projectState={projectState}
          activeDocumentPath={activeManuscriptPath(documentTabs, activeDocumentTabKey)}
          onOpenDocument={onOpenManuscript}
        />
      ) : (
        <MaterialsSidebar
          projectState={projectState}
          activeMaterialTitle={activeMaterialTitle(documentTabs, activeDocumentTabKey)}
          onOpenMaterial={onOpenMaterial}
          onRenameMaterial={onRenameMaterial}
          onDeleteMaterial={onDeleteMaterial}
        />
      )}
      <DocumentWorkspace
        tabs={documentTabs}
        activeTabKey={activeDocumentTabKey}
        onActivate={onActivateDocument}
        onClose={onCloseDocument}
      />
      <ChatPanel
        key={projectState.status === "open" ? projectState.project.id : "closed"}
        projectState={projectState}
      />
    </div>
  );
}

function activeManuscriptPath(
  tabs: readonly DocumentTab[],
  activeTabKey: string | null,
): string | null {
  const tab = tabs.find((item) => documentTabKey(item) === activeTabKey);
  return tab?.source === "manuscript" ? tab.reference : null;
}

function activeMaterialTitle(
  tabs: readonly DocumentTab[],
  activeTabKey: string | null,
): string | null {
  const tab = tabs.find((item) => documentTabKey(item) === activeTabKey);
  return tab?.source === "material" ? tab.reference : null;
}
