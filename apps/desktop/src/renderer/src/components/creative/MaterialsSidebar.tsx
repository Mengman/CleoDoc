import { Archive as ArchiveIcon } from "lucide-react";
import type { ReactNode } from "react";

import { LibrarySidebar } from "./LibrarySidebar.js";

export function MaterialsSidebar(): ReactNode {
  // Configure the shared library shell for imported project materials.
  return (
    <LibrarySidebar
      title="资料区"
      description="查看项目创作资料"
      listLabel="资料列表"
      itemCount={0}
      emptyIcon={<ArchiveIcon />}
    />
  );
}
