import { useEffect, useState } from "react";

import type { DesktopProjectState, DesktopRuntimeInfo } from "../../../shared/desktop-api.js";

export interface DesktopState {
  readonly projectState: DesktopProjectState;
  readonly runtimeInfo: DesktopRuntimeInfo | null;
}

export function useDesktopState(): DesktopState {
  // Load the initial desktop state and keep the project snapshot synchronized until unmount.
  const [runtimeInfo, setRuntimeInfo] = useState<DesktopRuntimeInfo | null>(null);
  const [projectState, setProjectState] = useState<DesktopProjectState>({ status: "closed" });

  useEffect(() => {
    // Subscribe before reading the initial state so project changes are not missed during startup.
    let active = true;
    const stopListening = window.cleodoc.onProjectStateChanged((state) => {
      if (active) setProjectState(state);
    });
    void Promise.all([window.cleodoc.getRuntimeInfo(), window.cleodoc.getProjectState()]).then(
      ([info, state]) => {
        if (!active) return;
        setRuntimeInfo(info);
        setProjectState(state);
      },
    );
    return () => {
      active = false;
      stopListening();
    };
  }, []);

  return { projectState, runtimeInfo };
}
