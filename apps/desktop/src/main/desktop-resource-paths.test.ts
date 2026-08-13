import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveDesktopDefaultConfigPath } from "./desktop-resource-paths.js";

describe("resolveDesktopDefaultConfigPath", () => {
  it("loads the repository resource in desktop development", () => {
    expect(
      resolveDesktopDefaultConfigPath({
        appPath: path.join("D:", "source", "CleoDoc"),
        resourcesPath: path.join(
          "D:",
          "source",
          "CleoDoc",
          "node_modules",
          "electron",
          "dist",
          "resources",
        ),
        isPackaged: false,
      }),
    ).toBe(path.join("D:", "source", "CleoDoc", "resources", "config", "software-default.yaml"));
  });

  it("loads the copied resource beside a packaged Electron application", () => {
    expect(
      resolveDesktopDefaultConfigPath({
        appPath: path.join("C:", "Program Files", "CleoDoc", "resources", "app.asar"),
        resourcesPath: path.join("C:", "Program Files", "CleoDoc", "resources"),
        isPackaged: true,
      }),
    ).toBe(
      path.join("C:", "Program Files", "CleoDoc", "resources", "config", "software-default.yaml"),
    );
  });
});
