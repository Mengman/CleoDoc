import { FileText as DocumentIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import type { DesktopProjectState } from "../../../../shared/desktop-api.js";
import { LibrarySidebar } from "./LibrarySidebar.js";

export function WorksSidebar({
  projectState,
  activeDocumentPath,
  onOpenDocument,
}: {
  readonly projectState: DesktopProjectState;
  readonly activeDocumentPath: string | null;
  readonly onOpenDocument: (relativePath: string) => void;
}): ReactNode {
  // Load and render the readable manuscript files owned by the active project.
  // 1. Clear the previous list whenever the active project changes or closes.
  // 2. Load the current Markdown/TXT paths through the desktop API.
  // 3. Show loading, error, empty, or populated content inside the existing sidebar shell.
  const projectId = projectState.status === "open" ? projectState.project.id : null;
  const [documents, setDocuments] = useState<readonly string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Load the initial list and subscribe to native manuscript directory updates.
    // 1. Reset state when the active project changes or closes.
    // 2. Subscribe before loading so a newer file event cannot be overwritten by a stale request.
    // 3. Dispose the project-scoped listener when this sidebar unmounts or switches projects.
    let active = true;
    let receivedChange = false;
    setDocuments([]);
    setError(null);
    if (projectId === null) {
      setLoading(false);
      return () => undefined;
    }
    const unsubscribe = window.cleodoc.onManuscriptDocumentsChanged((result) => {
      if (!active) return;
      receivedChange = true;
      setLoading(false);
      if (result.outcome === "error") setError(result.error.message);
      else {
        setError(null);
        setDocuments(result.documents);
      }
    });
    setLoading(true);
    void window.cleodoc
      .listManuscriptDocuments()
      .then((result) => {
        if (!active || receivedChange) return;
        if (result.outcome === "error") setError(result.error.message);
        else setDocuments(result.documents);
      })
      .catch(() => {
        if (active) setError("无法加载作品列表");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [projectId]);

  let content: ReactNode;
  if (projectId === null) content = undefined;
  else if (loading) content = <WorksListState message="正在加载作品…" />;
  else if (error !== null) content = <WorksListState message={error} error />;
  else if (documents.length === 0) content = <WorksListState message="当前项目暂无作品" />;
  else {
    content = (
      <ManuscriptList
        documents={documents}
        activeDocumentPath={activeDocumentPath}
        onOpenDocument={onOpenDocument}
      />
    );
  }

  return (
    <LibrarySidebar
      title="作品区"
      description="管理作品结构与文档"
      listLabel="作品目录"
      itemCount={documents.length}
      emptyIcon={<DocumentIcon />}
      content={content}
    />
  );
}

export function ManuscriptList({
  documents,
  activeDocumentPath,
  onOpenDocument,
}: {
  readonly documents: readonly string[];
  readonly activeDocumentPath: string | null;
  readonly onOpenDocument: (relativePath: string) => void;
}): ReactNode {
  // Display each manuscript path and open the selected file in the shared document workspace.
  return (
    <ul className="manuscript-list">
      {documents.map((relativePath) => (
        <li key={relativePath}>
          <button
            type="button"
            className={`manuscript-list-item${relativePath === activeDocumentPath ? " active" : ""}`}
            onClick={() => onOpenDocument(relativePath)}
          >
            <DocumentIcon />
            <span>{relativePath.slice("manuscript/".length)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function WorksListState({
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
