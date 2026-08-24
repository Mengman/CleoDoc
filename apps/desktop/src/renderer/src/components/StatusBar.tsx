import type { ReactNode } from "react";

export function StatusBar(): ReactNode {
  return (
    <footer className="status-bar" role="status" aria-live="polite">
      <span className="status-bar-idle">
        <i />
        就绪
      </span>
    </footer>
  );
}
