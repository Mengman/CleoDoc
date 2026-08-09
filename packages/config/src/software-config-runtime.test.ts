import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  getSoftwareConfig,
  getSoftwareDefaultConfigPath,
  getSoftwareUserConfigPath,
  initializeSoftwareConfig,
} from "./software-config-runtime.js";

const directories: string[] = [];

afterAll(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("software config runtime", () => {
  it("publishes the loaded configuration as one process-wide snapshot", async () => {
    const homeDirectory = await mkdtemp(path.join(tmpdir(), "cleodoc-config-runtime-"));
    directories.push(homeDirectory);
    const defaultConfigPath = path.resolve("resources/config/software-default.yaml");

    await initializeSoftwareConfig({
      environment: { CLEODOC_HOME: homeDirectory },
      defaultConfigPath,
    });

    expect(getSoftwareConfig().gpuAcceleration).toBe(true);
    expect(Object.isFrozen(getSoftwareConfig())).toBe(true);
    expect(Object.isFrozen(getSoftwareConfig().rag)).toBe(true);
    expect(getSoftwareDefaultConfigPath()).toBe(defaultConfigPath);
    expect(getSoftwareUserConfigPath()).toBe(path.join(homeDirectory, "config.yaml"));

    await writeFile(path.join(homeDirectory, "config.yaml"), "gpuAcceleration: false\n", "utf8");
    expect(getSoftwareConfig().gpuAcceleration).toBe(true);

    await initializeSoftwareConfig({
      environment: { CLEODOC_HOME: homeDirectory },
      defaultConfigPath,
    });
    expect(getSoftwareConfig().gpuAcceleration).toBe(false);
  });
});
