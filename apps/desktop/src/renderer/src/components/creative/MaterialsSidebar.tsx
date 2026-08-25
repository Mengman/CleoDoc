import {
  Archive as ArchiveIcon,
  Pencil as PencilIcon,
  Trash2 as TrashIcon,
  Upload as UploadIcon,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import type { DesktopProjectState } from "../../../../shared/desktop-api.js";
import { Button } from "../ui/button.js";
import { Input } from "../ui/input.js";
import { LibrarySidebar } from "./LibrarySidebar.js";

export function MaterialsSidebar({
  projectState,
  activeMaterialTitle,
  onOpenMaterial,
  onRenameMaterial,
  onDeleteMaterial,
}: {
  readonly projectState: DesktopProjectState;
  readonly activeMaterialTitle: string | null;
  readonly onOpenMaterial: (title: string) => void;
  readonly onRenameMaterial: (title: string, newTitle: string) => Promise<boolean>;
  readonly onDeleteMaterial: (title: string) => Promise<boolean>;
}): ReactNode {
  // Load and display the imported materials owned by the active project.
  // 1. Clear the previous list whenever the active project changes or closes.
  // 2. Load the current material titles through the desktop API.
  // 3. Import, rename, or delete a material, then refresh the list without replacing it on failure.
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

  async function deleteMaterial(title: string): Promise<boolean> {
    const deleted = await onDeleteMaterial(title);
    if (deleted) setReloadVersion((version) => version + 1);
    return deleted;
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
        onDeleteMaterial={deleteMaterial}
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
          <Button
            type="button"
            size="xs"
            disabled={importing}
            onClick={() => void importMaterial()}
          >
            <UploadIcon />
            {importing ? "正在导入…" : "导入资料"}
          </Button>
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
  onDeleteMaterial,
}: {
  readonly materials: readonly string[];
  readonly activeMaterialTitle: string | null;
  readonly onOpenMaterial: (title: string) => void;
  readonly onRenameMaterial: (title: string, newTitle: string) => Promise<boolean>;
  readonly onDeleteMaterial: (title: string) => Promise<boolean>;
}): ReactNode {
  // Display imported material titles and provide inline renaming or confirmed deletion actions.
  // 1. Open a material through its title while it is not being renamed.
  // 2. Replace only the selected item with a title input after its rename action is chosen.
  // 3. Keep the input open when persistence fails and close it after a successful rename.
  const [editingTitle, setEditingTitle] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [savingRename, setSavingRename] = useState(false);
  const [deletingTitle, setDeletingTitle] = useState<string | null>(null);

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

  async function deleteMaterial(title: string): Promise<void> {
    // Request deletion once and leave the list unchanged unless the confirmed operation succeeds.
    if (deletingTitle !== null) return;
    setDeletingTitle(title);
    try {
      await onDeleteMaterial(title);
    } finally {
      setDeletingTitle(null);
    }
  }

  return (
    <ul className="m-0 grid min-h-0 flex-1 content-start gap-1 overflow-auto p-0">
      {materials.map((title) => (
        <li key={title}>
          {editingTitle === title ? (
            <form
              className="m-0 flex"
              onSubmit={(event) => {
                event.preventDefault();
                void submitRename(title);
              }}
            >
              <Input
                className="h-auto rounded-lg px-2.5 py-[9px] text-[11px]"
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
            <div
              className={`material-list-entry${title === activeMaterialTitle ? " active" : ""} flex items-center overflow-hidden rounded-lg transition-colors ${
                title === activeMaterialTitle ? "bg-accent" : "bg-surface-raised hover:bg-accent"
              }`}
            >
              <button
                type="button"
                className={`flex min-w-0 flex-1 items-center rounded-lg px-2.5 py-[9px] text-left text-[11px] ${
                  title === activeMaterialTitle
                    ? "text-accent-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
                onClick={() => onOpenMaterial(title)}
              >
                <span className="overflow-hidden text-ellipsis whitespace-nowrap">{title}</span>
              </button>
              <button
                type="button"
                className="mr-1 grid size-[30px] flex-none place-items-center rounded-md text-muted-foreground hover:bg-primary hover:text-primary-foreground [&>svg]:size-[13px]"
                aria-label={`重命名 ${title}`}
                title="重命名资料"
                onClick={() => {
                  setDraftTitle(title);
                  setEditingTitle(title);
                }}
              >
                <PencilIcon />
              </button>
              <button
                type="button"
                className="mr-1 grid size-[30px] flex-none place-items-center rounded-md text-muted-foreground hover:bg-destructive hover:text-destructive-foreground disabled:cursor-default disabled:opacity-50 [&>svg]:size-[13px]"
                aria-label={`删除 ${title}`}
                title="删除资料"
                disabled={deletingTitle !== null}
                onClick={() => void deleteMaterial(title)}
              >
                <TrashIcon />
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
    <div
      className={`px-3 py-6 text-center text-[10px] ${error ? "text-destructive" : "text-muted-foreground"}`}
    >
      <span>{message}</span>
    </div>
  );
}
