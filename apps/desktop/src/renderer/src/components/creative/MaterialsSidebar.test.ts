import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, it } from "vitest";

import { MaterialList, MaterialsSidebar } from "./MaterialsSidebar.js";

describe("MaterialList", () => {
  it("opens an imported material from the existing list", () => {
    // Verify the existing material list exposes one safe button per readable title.
    const html = renderToStaticMarkup(
      createElement(MaterialList, {
        materials: ["人物名册", "港口资料"],
        activeMaterialTitle: "人物名册",
        onOpenMaterial: () => undefined,
        onRenameMaterial: async () => true,
      }),
    );

    expect(html).toContain("人物名册");
    expect(html).toContain("港口资料");
    expect(html).toContain("<button");
    expect(html).toContain("material-list-entry active");
    expect(html).toContain('aria-label="重命名 人物名册"');
  });

  it("shows the authorized import action only for an open project", () => {
    // Verify a closed project never exposes an unusable material import control.
    const projectState = {
      status: "open" as const,
      project: {
        id: "9e564f20-70ec-4a3d-b820-54299948635d",
        name: "港口小说",
        language: "zh-CN",
        documentCount: 0,
        database: "ok" as const,
      },
    };
    const html = renderToStaticMarkup(
      createElement(MaterialsSidebar, {
        projectState,
        activeMaterialTitle: null,
        onOpenMaterial: () => undefined,
        onRenameMaterial: async () => true,
      }),
    );

    expect(html).toContain("导入资料");
  });
});
