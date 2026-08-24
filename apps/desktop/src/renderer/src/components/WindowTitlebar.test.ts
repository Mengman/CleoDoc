import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, it } from "vitest";

import { WindowTitlebar } from "./WindowTitlebar.js";

describe("WindowTitlebar", () => {
  it("shows the current project folder name and falls back to CleoDoc", () => {
    // Verify title-bar text follows the safe active-project state.
    const openProjectHtml = renderToStaticMarkup(
      createElement(WindowTitlebar, {
        projectState: {
          status: "open",
          project: {
            id: "9e564f20-70ec-4a3d-b820-54299948635d",
            name: "展示名称",
            folderName: "actual-folder.cleo",
            language: "zh-CN",
            documentCount: 0,
            database: "ok",
          },
        },
      }),
    );
    const closedProjectHtml = renderToStaticMarkup(
      createElement(WindowTitlebar, { projectState: { status: "closed" } }),
    );

    expect(openProjectHtml).toContain("actual-folder.cleo");
    expect(openProjectHtml).not.toContain("展示名称");
    expect(closedProjectHtml).toContain("CleoDoc");
  });
});
