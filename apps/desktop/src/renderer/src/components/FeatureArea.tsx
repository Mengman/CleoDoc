import { useEffect, useState, type ReactNode } from "react";

import type { DesktopProjectState, DesktopRuntimeInfo } from "../../../shared/desktop-api.js";
import type { NavigationId } from "../ui-types.js";
import { CreativeWorkspace } from "./creative/CreativeWorkspace.js";
import { documentTabKey, type DocumentTab } from "./creative/DocumentWorkspace.js";
import { SettingsWorkspace } from "./settings/SettingsWorkspace.js";

export interface FeatureAreaProps {
  readonly activeNavigation: NavigationId;
  readonly projectState: DesktopProjectState;
  readonly runtimeInfo: DesktopRuntimeInfo | null;
}

interface DocumentWorkspaceState {
  readonly projectId: string | null;
  readonly tabs: readonly DocumentTab[];
  readonly activeTabKey: string | null;
}

export function FeatureArea({
  activeNavigation,
  projectState,
  runtimeInfo,
}: FeatureAreaProps): ReactNode {
  // Own the project-bound document tabs while switching visible feature workspaces.
  // 1. Expose no tabs from a previous project, then clear retained state after project changes.
  // 2. Open each manuscript path once and apply its asynchronous result only to that project.
  // 3. Preserve the tab collection while the settings workspace temporarily replaces the view.
  // 4. Handle tab activation and closing without rereading documents that remain open.
  const projectId = projectState.status === "open" ? projectState.project.id : null;
  const [documents, setDocuments] = useState<DocumentWorkspaceState>({
    projectId,
    tabs: [],
    activeTabKey: null,
  });
  const visibleDocuments =
    documents.projectId === projectId ? documents : { projectId, tabs: [], activeTabKey: null };

  useEffect(() => {
    setDocuments({ projectId, tabs: [], activeTabKey: null });
  }, [projectId]);

  function openManuscript(relativePath: string): void {
    openDocument("manuscript", relativePath);
  }

  function openMaterial(title: string): void {
    openDocument("material", title);
  }

  async function renameMaterial(title: string, newTitle: string): Promise<boolean> {
    // Rename one material and retain its already loaded tab content under the new title.
    const result = await window.cleodoc.renameMaterial({ title, newTitle });
    if (result.outcome === "error") return false;
    const oldKey = documentTabKey({ source: "material", reference: title });
    const newKey = documentTabKey({ source: "material", reference: result.title });
    setDocuments((current) =>
      current.projectId !== projectId
        ? current
        : {
            ...current,
            activeTabKey: current.activeTabKey === oldKey ? newKey : current.activeTabKey,
            tabs: current.tabs.map((tab) =>
              documentTabKey(tab) === oldKey ? { ...tab, reference: result.title } : tab,
            ),
          },
    );
    return true;
  }

  async function deleteMaterial(title: string): Promise<boolean> {
    const result = await window.cleodoc.deleteMaterial(title);
    if (result.outcome !== "success") return false;
    closeDocument({ source: "material", reference: result.title, content: null, error: null });
    return true;
  }

  function openDocument(source: DocumentTab["source"], reference: string): void {
    // Activate one open tab or load a new manuscript or material tab through Typed IPC.
    // 1. Reuse an existing tab without issuing another file read.
    // 2. Append and activate a loading tab for a newly selected current-project document.
    // 3. Apply the eventual content or safe error only to the originating project and tab.
    const requestProjectId = projectId;
    if (requestProjectId === null) return;
    const tab: DocumentTab = { source, reference, content: null, error: null };
    if (
      visibleDocuments.tabs.some((existing) => documentTabKey(existing) === documentTabKey(tab))
    ) {
      activateDocument(tab);
      return;
    }
    setDocuments((current) => {
      const state = current.projectId === requestProjectId ? current : visibleDocuments;
      return {
        ...state,
        activeTabKey: documentTabKey(tab),
        tabs: [...state.tabs, tab],
      };
    });
    const reader =
      source === "manuscript"
        ? window.cleodoc.readManuscriptDocument(reference)
        : window.cleodoc.readMaterial(reference);
    void reader
      .then((result) => updateLoadedDocument(requestProjectId, tab, result))
      .catch(() => {
        updateDocumentError(requestProjectId, tab, "无法读取文档");
      });
  }

  function activateDocument(tab: DocumentTab): void {
    setDocuments((current) =>
      current.projectId === projectId ? { ...current, activeTabKey: documentTabKey(tab) } : current,
    );
  }

  function closeDocument(tab: DocumentTab): void {
    // Remove one tab and activate its next neighbor when the active tab closes.
    setDocuments((current) => {
      if (current.projectId !== projectId) return current;
      const closingKey = documentTabKey(tab);
      const closedIndex = current.tabs.findIndex((item) => documentTabKey(item) === closingKey);
      if (closedIndex === -1) return current;
      const tabs = current.tabs.filter((item) => documentTabKey(item) !== closingKey);
      const nextActiveTab = tabs[closedIndex] ?? tabs[closedIndex - 1] ?? null;
      return {
        ...current,
        tabs,
        activeTabKey:
          current.activeTabKey === closingKey
            ? nextActiveTab === null
              ? null
              : documentTabKey(nextActiveTab)
            : current.activeTabKey,
      };
    });
  }

  function updateLoadedDocument(
    requestProjectId: string,
    tab: DocumentTab,
    result:
      | Awaited<ReturnType<typeof window.cleodoc.readManuscriptDocument>>
      | Awaited<ReturnType<typeof window.cleodoc.readMaterial>>,
  ): void {
    // Apply one read result only when its project and tab are still active in this workspace.
    if (result.outcome === "error") {
      updateDocumentError(requestProjectId, tab, result.error.message);
      return;
    }
    setDocuments((current) =>
      current.projectId !== requestProjectId
        ? current
        : {
            ...current,
            tabs: current.tabs.map((item) =>
              documentTabKey(item) === documentTabKey(tab)
                ? { ...item, content: result.content }
                : item,
            ),
          },
    );
  }

  function updateDocumentError(requestProjectId: string, tab: DocumentTab, message: string): void {
    // Keep a failed tab visible with its safe read error when the project still matches.
    setDocuments((current) =>
      current.projectId !== requestProjectId
        ? current
        : {
            ...current,
            tabs: current.tabs.map((item) =>
              documentTabKey(item) === documentTabKey(tab) ? { ...item, error: message } : item,
            ),
          },
    );
  }

  return (
    <section className="feature-area">
      {activeNavigation === "settings" ? (
        <SettingsWorkspace />
      ) : (
        <CreativeWorkspace
          activeSidebar={activeNavigation}
          projectState={projectState}
          runtimeInfo={runtimeInfo}
          documentTabs={visibleDocuments.tabs}
          activeDocumentTabKey={visibleDocuments.activeTabKey}
          onOpenManuscript={openManuscript}
          onOpenMaterial={openMaterial}
          onRenameMaterial={renameMaterial}
          onDeleteMaterial={deleteMaterial}
          onActivateDocument={activateDocument}
          onCloseDocument={closeDocument}
        />
      )}
    </section>
  );
}
