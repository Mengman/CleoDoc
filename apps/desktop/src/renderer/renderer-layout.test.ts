import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("desktop workspace layout", () => {
  // Verify the structural rules that keep the current desktop workspace layout stable.
  it("uses the full workspace below the titlebar and anchors bottom controls", async () => {
    // Verify the existing full-height workspace, bottom settings, and chat layout hooks.
    const [app, styles] = await Promise.all([
      readFile(new URL("./src/App.tsx", import.meta.url), "utf8"),
      readFile(new URL("./src/styles.css", import.meta.url), "utf8"),
    ]);

    expect(app).not.toContain('className="topbar"');
    expect(app).toContain('className="rail-items rail-bottom"');
    expect(app).toContain('className="conversation-stream"');
    expect(styles).toContain("grid-template-rows: 40px minmax(0, 1fr);");
    expect(styles).toContain("grid-template-rows: minmax(0, 1fr) auto;");
    expect(styles).toContain("justify-content: space-between;");
  });
});
