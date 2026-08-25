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
    expect((await service.read()).recentDirectory).toBe(home);
    expect(service.statePath).toBe(path.join(home, "state.yaml"));
  });

  it("ignores an invalid state file instead of treating it as user configuration", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "cleodoc-state-"));
    temporaryDirectories.push(home);
    const service = new AppStateService({ CLEODOC_HOME: home });
    await writeFile(service.statePath, "not: [valid", "utf8");

    expect((await service.read()).currentProject).toBeNull();
  });

  it("retains the recent directory after closing a project", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "cleodoc-state-"));
    temporaryDirectories.push(home);
    const service = new AppStateService({ CLEODOC_HOME: home });
    await service.setCurrentProject(path.join(home, "novel.cleo"));

    const cleared = await service.clearCurrentProject();

    expect(cleared.currentProject).toBeNull();
    expect(cleared.recentDirectory).toBe(home);
    await expect(service.read()).resolves.toEqual(cleared);
  });

  it("keeps the ten most recently opened projects without duplicates", async () => {
    // Verify reopening a project moves it to the front while the list remains bounded.
    // 1. Store more projects than the list permits.
    // 2. Reopen an existing project.
    // 3. Confirm its new position and the retained ten-item ordering.
    const home = await mkdtemp(path.join(tmpdir(), "cleodoc-state-"));
    temporaryDirectories.push(home);
    const service = new AppStateService({ CLEODOC_HOME: home });
    const projects = Array.from({ length: 11 }, (_, index) => path.join(home, `novel-${index}`));

    for (const project of projects) await service.setCurrentProject(project);
    await service.setCurrentProject(projects[3]!);

    await expect(service.read()).resolves.toMatchObject({
      currentProject: projects[3],
      recentProjects: [
        projects[3],
        projects[10],
        projects[9],
        projects[8],
        projects[7],
        projects[6],
        projects[5],
        projects[4],
        projects[2],
        projects[1],
      ],
    });
  });

  it("removes individual recent projects and clears the complete list", async () => {
    // Verify failed recent-project entries and the menu command only change the recent list.
    const home = await mkdtemp(path.join(tmpdir(), "cleodoc-state-"));
    temporaryDirectories.push(home);
    const service = new AppStateService({ CLEODOC_HOME: home });
    const first = path.join(home, "first");
    const second = path.join(home, "second");
    await service.setCurrentProject(first);
    await service.setCurrentProject(second);

    const removed = await service.removeRecentProject(first);
    expect(removed.recentProjects).toEqual([second]);
    await expect(service.clearRecentProjects()).resolves.toMatchObject({
      currentProject: second,
      recentProjects: [],
    });
  });
});
