import { describe, expect, it, vi } from "vitest";

import { desktopChannels, type DesktopProjectState } from "../shared/desktop-api.js";
import { sendProjectState, type DesktopProjectStateTarget } from "./desktop-ipc.js";

describe("sendProjectState", () => {
  it("sends state only to the supplied main window", () => {
    const mainWindow = createTarget(false);
    const unrelatedWindow = createTarget(false);
    const state: DesktopProjectState = { status: "closed" };

    sendProjectState(mainWindow.target, state);

    expect(mainWindow.send).toHaveBeenCalledWith(desktopChannels.projectStateChanged, state);
    expect(unrelatedWindow.send).not.toHaveBeenCalled();
  });

  it("does not send after the main window is destroyed", () => {
    const mainWindow = createTarget(true);

    sendProjectState(mainWindow.target, { status: "closed" });

    expect(mainWindow.send).not.toHaveBeenCalled();
  });
});

function createTarget(destroyed: boolean): {
  readonly target: DesktopProjectStateTarget;
  readonly send: ReturnType<typeof vi.fn>;
} {
  // Create a minimal window target whose notification calls can be asserted.
  const send = vi.fn();
  return {
    target: { isDestroyed: () => destroyed, webContents: { send } },
    send,
  };
}
