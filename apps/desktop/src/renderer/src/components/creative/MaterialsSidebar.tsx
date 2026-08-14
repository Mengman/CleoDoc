import { Archive as ArchiveIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import type { DesktopProjectState } from "../../../../shared/desktop-api.js";
import { LibrarySidebar } from "./LibrarySidebar.js";

export function MaterialsSidebar({
  projectState,
}: {
  readonly projectState: DesktopProjectState;
}): ReactNode {
  // Load and display the imported materials owned by the active project.
  // 1. Clear the previous list whenever the active project changes or closes.
  // 2. Load the current material titles through the desktop API.
  // 3. Show loading, error, empty, or populated content without opening materials.
  const projectId = projectState.status === "open" ? projectState.project.id : null;
  const [materials, setMaterials] = useState<readonly string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Refresh material titles for the current project without retaining stale responses.
    // 1. Reset state when the project identity changes or closes.
    // 2. Request the current titles through the preload API.
    // 3. Ignore responses after the effect has been disposed.
    let active = true;
    setMaterials([]);
    setError(null);
    if (projectId === null) {
      setLoading(false);
      return () => undefined;
    }
    setLoading(true);
    void window.cleodoc
      .listMaterials()
      .then((result) => {
        if (!active) return;
        if (result.outcome === "error") setError(result.error.message);
        else setMaterials(result.materials);
      })
      .catch(() => {
        if (active) setError("无法加载资料列表");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [projectId]);

  let content: ReactNode;
  if (projectId === null) content = undefined;
  else if (loading) content = <MaterialsListState message="正在加载资料…" />;
  else if (error !== null) content = <MaterialsListState message={error} error />;
  else if (materials.length === 0) content = <MaterialsListState message="当前项目暂无资料" />;
  else content = <MaterialList materials={materials} />;

  return (
    <LibrarySidebar
      title="资料区"
      description="查看项目创作资料"
      listLabel="资料列表"
      itemCount={materials.length}
      emptyIcon={<ArchiveIcon />}
      content={content}
    />
  );
}

export function MaterialList({ materials }: { readonly materials: readonly string[] }): ReactNode {
  // Display imported material titles without enabling read interactions.
  return (
    <ul className="material-list">
      {materials.map((title) => (
        <li key={title} className="material-list-item">
          <span>{title}</span>
        </li>
      ))}
    </ul>
  );
}

function MaterialsListState({
  message,
  error = false,
}: {
  message: string;
  error?: boolean;
}): ReactNode {
  return (
    <div className={`works-list-state${error ? " error" : ""}`}>
      <span>{message}</span>
    </div>
  );
}
