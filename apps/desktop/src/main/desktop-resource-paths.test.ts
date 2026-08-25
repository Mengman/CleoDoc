import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveDesktopDefaultConfigPath } from "./desktop-resource-paths.js";

describe("resolveDesktopDefaultConfigPath", () => {
  // Verify default configuration lookup for both supported desktop distribution modes.
  // 1. Check that development resolves resources from the repository root.
  // 2. Check that packaged builds resolve resources beside the Electron application.
  it("loads the repository resource in desktop development", () => {
    // Verify that development uses the repository resource instead of the build directory.
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
    // Verify that packaged applications use the resource copied outside the ASAR archive.
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
