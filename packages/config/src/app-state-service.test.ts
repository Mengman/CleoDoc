import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AppStateService } from "./app-state-service.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("AppStateService", () => {
  it("stores the current project separately from user configuration", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "cleodoc-state-"));
    temporaryDirectories.push(home);
    const service = new AppStateService({ CLEODOC_HOME: home });

    expect((await service.read()).currentProject).toBeNull();
    await service.setCurrentProject(path.join(home, "novel.cleo"));

    expect((await service.read()).currentProject).toBe(path.resolve(home, "novel.cleo"));
    expect(service.statePath).toBe(path.join(home, "state.yaml"));
  });

  it("ignores an invalid state file instead of treating it as user configuration", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "cleodoc-state-"));
    temporaryDirectories.push(home);
    const service = new AppStateService({ CLEODOC_HOME: home });
    await writeFile(service.statePath, "not: [valid", "utf8");

    expect((await service.read()).currentProject).toBeNull();
  });

  it("clears the current project without retaining its path", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "cleodoc-state-"));
    temporaryDirectories.push(home);
    const service = new AppStateService({ CLEODOC_HOME: home });
    await service.setCurrentProject(path.join(home, "novel.cleo"));

    const cleared = await service.clearCurrentProject();

    expect(cleared.currentProject).toBeNull();
    await expect(service.read()).resolves.toEqual(cleared);
  });
});
