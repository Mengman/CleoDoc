import { Archive as ArchiveIcon, Pencil as PencilIcon, Upload as UploadIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import type { DesktopProjectState } from "../../../../shared/desktop-api.js";
import { LibrarySidebar } from "./LibrarySidebar.js";

export function MaterialsSidebar({
  projectState,
  activeMaterialTitle,
  onOpenMaterial,
  onRenameMaterial,
}: {
  readonly projectState: DesktopProjectState;
  readonly activeMaterialTitle: string | null;
  readonly onOpenMaterial: (title: string) => void;
  readonly onRenameMaterial: (title: string, newTitle: string) => Promise<boolean>;
}): ReactNode {
  // Load and display the imported materials owned by the active project.
  // 1. Clear the previous list whenever the active project changes or closes.
  // 2. Load the current material titles through the desktop API.
  // 3. Import or rename a material, then refresh the list without replacing it on failure.
  // 4. Show loading, error, empty, or populated content while opening selected materials.
  const projectId = projectState.status === "open" ? projectState.project.id : null;
  const [materials, setMaterials] = useState<readonly string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [reloadVersion, setReloadVersion] = useState(0);

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
  }, [projectId, reloadVersion]);

  async function importMaterial(): Promise<void> {
    // Open the native file picker and refresh or open the returned material result.
    if (projectId === null || importing) return;
    setImporting(true);
    setError(null);
    try {
      const result = await window.cleodoc.chooseAndImportMaterial();
      if (result.outcome === "success") {
        setReloadVersion((version) => version + 1);
        onOpenMaterial(result.material.title);
      }
    } catch {
      // Native IPC failures do not replace the existing material list.
    } finally {
      setImporting(false);
    }
  }

  async function renameMaterial(title: string, newTitle: string): Promise<boolean> {
    const renamed = await onRenameMaterial(title, newTitle);
    if (renamed) setReloadVersion((version) => version + 1);
    return renamed;
  }

  let content: ReactNode;
  if (projectId === null) content = undefined;
  else if (loading) content = <MaterialsListState message="正在加载资料…" />;
  else if (error !== null) content = <MaterialsListState message={error} error />;
  else if (materials.length === 0) content = <MaterialsListState message="当前项目暂无资料" />;
  else {
    content = (
      <MaterialList
        materials={materials}
        activeMaterialTitle={activeMaterialTitle}
        onOpenMaterial={onOpenMaterial}
        onRenameMaterial={renameMaterial}
      />
    );
  }

  return (
    <LibrarySidebar
      title="资料区"
      description="查看项目创作资料"
      listLabel="资料列表"
      itemCount={materials.length}
      emptyIcon={<ArchiveIcon />}
      content={content}
      action={
        projectId === null ? undefined : (
          <button
            type="button"
            className="material-import-button"
            disabled={importing}
            onClick={() => void importMaterial()}
          >
            <UploadIcon />
            {importing ? "正在导入…" : "导入资料"}
          </button>
        )
      }
    />
  );
}

export function MaterialList({
  materials,
  activeMaterialTitle,
  onOpenMaterial,
  onRenameMaterial,
}: {
  readonly materials: readonly string[];
  readonly activeMaterialTitle: string | null;
  readonly onOpenMaterial: (title: string) => void;
  readonly onRenameMaterial: (title: string, newTitle: string) => Promise<boolean>;
}): ReactNode {
  // Display imported material titles and provide inline renaming for one selected item.
  // 1. Open a material through its title while it is not being renamed.
  // 2. Replace only the selected item with a title input after its rename action is chosen.
  // 3. Keep the input open when persistence fails and close it after a successful rename.
  const [editingTitle, setEditingTitle] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [savingRename, setSavingRename] = useState(false);

  async function submitRename(title: string): Promise<void> {
    // Persist the trimmed title and retain the editor when the rename does not succeed.
    const newTitle = draftTitle.trim();
    if (newTitle.length === 0 || savingRename) return;
    setSavingRename(true);
    try {
      if (await onRenameMaterial(title, newTitle)) {
        setEditingTitle(null);
      }
    } finally {
      setSavingRename(false);
    }
  }

  return (
    <ul className="material-list">
      {materials.map((title) => (
        <li key={title}>
          {editingTitle === title ? (
            <form
              className="material-rename-form"
              onSubmit={(event) => {
                event.preventDefault();
                void submitRename(title);
              }}
            >
              <input
                autoFocus
                required
                maxLength={200}
                aria-label={`重命名 ${title}`}
                value={draftTitle}
                disabled={savingRename}
                onChange={(event) => setDraftTitle(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setEditingTitle(null);
                }}
              />
            </form>
          ) : (
            <div className={`material-list-entry${title === activeMaterialTitle ? " active" : ""}`}>
              <button
                type="button"
                className="material-list-item"
                onClick={() => onOpenMaterial(title)}
              >
                <span>{title}</span>
              </button>
              <button
                type="button"
                className="material-rename-button"
                aria-label={`重命名 ${title}`}
                title="重命名资料"
                onClick={() => {
                  setDraftTitle(title);
                  setEditingTitle(title);
                }}
              >
                <PencilIcon />
              </button>
            </div>
          )}
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
