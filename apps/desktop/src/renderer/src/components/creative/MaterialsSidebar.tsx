import { Archive as ArchiveIcon } from "lucide-react";
import type { ReactNode } from "react";

import type { DesktopProjectState } from "../../../../shared/desktop-api.js";
import { LibrarySidebar } from "./LibrarySidebar.js";

export function MaterialsSidebar({
  projectState,
}: {
  readonly projectState: DesktopProjectState;
}): ReactNode {
  // Configure the shared library shell for imported project materials.
  return (
    <LibrarySidebar
      title="资料区"
      description="查看项目创作资料"
      searchLabel="搜索资料…"
      listLabel="资料列表"
      itemCount={0}
      emptyIcon={<ArchiveIcon />}
      projectState={projectState}
    />
  );
}
