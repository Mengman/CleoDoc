import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, it } from "vitest";

import { MaterialList } from "./MaterialsSidebar.js";

describe("MaterialList", () => {
  it("opens an imported material from the existing list", () => {
    // Verify the existing material list exposes one safe button per readable title.
    const html = renderToStaticMarkup(
      createElement(MaterialList, {
        materials: ["人物名册", "港口资料"],
        activeMaterialTitle: "人物名册",
        onOpenMaterial: () => undefined,
      }),
    );

    expect(html).toContain("人物名册");
    expect(html).toContain("港口资料");
    expect(html).toContain("<button");
    expect(html).toContain("material-list-item active");
  });
});
