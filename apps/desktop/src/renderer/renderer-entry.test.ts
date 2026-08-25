import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("desktop renderer entry", () => {
  // Verify that startup keeps styles CSP-safe and applies the selected theme before rendering.
  it("loads styles through an external stylesheet compatible with the strict CSP", async () => {
    // Verify that styles and the theme bootstrap run without relying on injected renderer CSS.
    const [html, rendererEntry] = await Promise.all([
      readFile(new URL("./index.html", import.meta.url), "utf8"),
      readFile(new URL("./src/main.tsx", import.meta.url), "utf8"),
    ]);

    expect(html).toContain('<link rel="stylesheet" href="/src/styles.css" />');
    expect(html).not.toContain('href="/src/titlebar.css"');
    expect(html).toContain('<link rel="stylesheet" href="/src/project-home.css" />');
    expect(html).toContain('<link rel="stylesheet" href="/src/chat-approval.css" />');
    expect(html).toContain('<link rel="stylesheet" href="/src/tailwind.css" />');
    expect(html).toContain("style-src 'self'");
    expect(rendererEntry).not.toContain('import "./styles.css"');
    expect(rendererEntry.indexOf("getThemeBootstrap")).toBeLessThan(
      rendererEntry.indexOf("createRoot(rendererRoot).render"),
    );
  });
});
