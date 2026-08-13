import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("desktop renderer entry", () => {
  // Verify that the renderer entry remains compatible with the strict style policy.
  it("loads styles through an external stylesheet compatible with the strict CSP", async () => {
    // Verify that styles load from HTML links instead of injected renderer imports.
    const [html, rendererEntry] = await Promise.all([
      readFile(new URL("./index.html", import.meta.url), "utf8"),
      readFile(new URL("./src/main.tsx", import.meta.url), "utf8"),
    ]);

    expect(html).toContain('<link rel="stylesheet" href="/src/styles.css" />');
    expect(html).toContain('<link rel="stylesheet" href="/src/titlebar.css" />');
    expect(html).toContain("style-src 'self'");
    expect(rendererEntry).not.toContain('import "./styles.css"');
  });
});
