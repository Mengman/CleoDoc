import { FileText as DocumentIcon } from "lucide-react";
import type { ReactNode } from "react";

import type { DesktopProjectState } from "../../../../shared/desktop-api.js";
import { LibrarySidebar } from "./LibrarySidebar.js";

export function WorksSidebar({
  projectState,
}: {
  readonly projectState: DesktopProjectState;
}): ReactNode {
  // Configure the shared library shell for project works and their navigation.
  return (
    <LibrarySidebar
      title="作品区"
      description="管理作品结构与文档"
      searchLabel="搜索作品…"
      listLabel="作品目录"
      itemCount={projectState.status === "open" ? projectState.project.documentCount : 0}
      emptyIcon={<DocumentIcon />}
      projectState={projectState}
    />
  );
}
