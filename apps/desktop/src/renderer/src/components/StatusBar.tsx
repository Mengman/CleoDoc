import type { ReactNode } from "react";

export function StatusBar(): ReactNode {
  return (
    <footer
      className="col-span-full row-start-3 flex min-w-0 items-center bg-primary px-3 text-[10px] text-primary-foreground"
      role="status"
      aria-live="polite"
    >
      <span className="inline-flex items-center gap-1.5">
        <i className="size-1.5 rounded-full bg-success" />
        就绪
      </span>
    </footer>
  );
}
