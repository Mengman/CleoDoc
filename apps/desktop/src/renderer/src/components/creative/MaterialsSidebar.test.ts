import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, it } from "vitest";

import { MaterialList } from "./MaterialsSidebar.js";

describe("MaterialList", () => {
  it("shows imported material titles without read controls", () => {
    // Verify the current material list is visible but remains non-interactive.
    const html = renderToStaticMarkup(
      createElement(MaterialList, { materials: ["人物名册", "港口资料"] }),
    );

    expect(html).toContain("人物名册");
    expect(html).toContain("港口资料");
    expect(html).not.toContain("<button");
  });
});
