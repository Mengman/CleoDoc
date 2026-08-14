import { useEffect, useState, type ReactNode } from "react";

import type { DesktopProjectState, DesktopRuntimeInfo } from "../../../shared/desktop-api.js";
import type { NavigationId } from "../ui-types.js";
import { CreativeWorkspace } from "./creative/CreativeWorkspace.js";
import type { ManuscriptTab } from "./creative/DocumentWorkspace.js";
import { SettingsWorkspace } from "./settings/SettingsWorkspace.js";

export interface FeatureAreaProps {
  readonly activeNavigation: NavigationId;
  readonly projectState: DesktopProjectState;
  readonly runtimeInfo: DesktopRuntimeInfo | null;
}

interface ManuscriptWorkspaceState {
  readonly projectId: string | null;
  readonly tabs: readonly ManuscriptTab[];
  readonly activePath: string | null;
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
  const [manuscripts, setManuscripts] = useState<ManuscriptWorkspaceState>({
    projectId,
    tabs: [],
    activePath: null,
  });
  const visibleManuscripts =
    manuscripts.projectId === projectId ? manuscripts : { projectId, tabs: [], activePath: null };

  useEffect(() => {
    setManuscripts({ projectId, tabs: [], activePath: null });
  }, [projectId]);

  function openManuscript(relativePath: string): void {
    // Activate an existing tab or create one placeholder and load its text through Typed IPC.
    // 1. Reuse an existing tab without issuing another file read.
    // 2. Append and activate a loading tab for a newly selected project path.
    // 3. Apply the eventual content or safe error only to the originating project.
    const requestProjectId = projectId;
    if (requestProjectId === null) return;
    if (visibleManuscripts.tabs.some((tab) => tab.relativePath === relativePath)) {
      activateManuscript(relativePath);
      return;
    }
    setManuscripts((current) => {
      const state = current.projectId === requestProjectId ? current : visibleManuscripts;
      return {
        ...state,
        activePath: relativePath,
        tabs: [...state.tabs, { relativePath, content: null, error: null }],
      };
    });
    void window.cleodoc
      .readManuscriptDocument(relativePath)
      .then((result) => {
        updateLoadedManuscript(requestProjectId, relativePath, result);
      })
      .catch(() => {
        updateManuscriptError(requestProjectId, relativePath, "无法读取文档");
      });
  }

  function activateManuscript(relativePath: string): void {
    setManuscripts((current) =>
      current.projectId === projectId ? { ...current, activePath: relativePath } : current,
    );
  }

  function closeManuscript(relativePath: string): void {
    // Remove one tab and activate its next neighbor when the active tab closes.
    setManuscripts((current) => {
      if (current.projectId !== projectId) return current;
      const closedIndex = current.tabs.findIndex((tab) => tab.relativePath === relativePath);
      if (closedIndex === -1) return current;
      const tabs = current.tabs.filter((tab) => tab.relativePath !== relativePath);
      const activePath =
        current.activePath === relativePath
          ? (tabs[closedIndex]?.relativePath ?? tabs[closedIndex - 1]?.relativePath ?? null)
          : current.activePath;
      return { ...current, tabs, activePath };
    });
  }

  function updateLoadedManuscript(
    requestProjectId: string,
    relativePath: string,
    result: Awaited<ReturnType<typeof window.cleodoc.readManuscriptDocument>>,
  ): void {
    // Apply one read result only when its project and tab are still active in this workspace.
    if (result.outcome === "error") {
      updateManuscriptError(requestProjectId, relativePath, result.error.message);
      return;
    }
    setManuscripts((current) =>
      current.projectId !== requestProjectId
        ? current
        : {
            ...current,
            tabs: current.tabs.map((tab) =>
              tab.relativePath === relativePath ? { ...tab, content: result.content } : tab,
            ),
          },
    );
  }

  function updateManuscriptError(
    requestProjectId: string,
    relativePath: string,
    message: string,
  ): void {
    // Keep a failed tab visible with its safe read error when the project still matches.
    setManuscripts((current) =>
      current.projectId !== requestProjectId
        ? current
        : {
            ...current,
            tabs: current.tabs.map((tab) =>
              tab.relativePath === relativePath ? { ...tab, error: message } : tab,
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
          manuscriptTabs={visibleManuscripts.tabs}
          activeManuscriptPath={visibleManuscripts.activePath}
          onOpenManuscript={openManuscript}
          onActivateManuscript={activateManuscript}
          onCloseManuscript={closeManuscript}
        />
      )}
    </section>
  );
}
