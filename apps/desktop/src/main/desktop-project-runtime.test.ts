import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AppStateService } from "../../../../packages/config/src/index.js";
import { ProjectService } from "../../../../packages/project/src/index.js";
import { TEST_CHAT_OPTIONS, TEST_DATABASE_OPTIONS } from "../../../../test/runtime-options.js";
import { DesktopProjectRuntime, toDesktopOperationError } from "./desktop-project-runtime.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("DesktopProjectRuntime", () => {
  // Verify the complete desktop project-session lifecycle and its public safety boundary.
  // 1. Check safe state projection and single-project switching behavior.
  // 2. Check restoration, cancellation, cleanup, and remembered-project semantics.
  // 3. Check that desktop errors expose no internal implementation details.
  it("exposes a safe project summary without the project path", async () => {
    // Verify that renderer state contains project metadata but never its absolute path.
    const fixture = await createRuntimeFixture();
    const project = await fixture.projectService.create(
      path.join(fixture.root, "private-location", "novel.cleo"),
      "边界测试",
    );

    const state = await fixture.runtime.open(project.root);

    expect(state).toEqual({
      status: "open",
      project: {
        id: project.manifest.id,
        name: "边界测试",
        language: project.manifest.language,
        documentCount: 0,
        database: "ok",
      },
    });
    expect(JSON.stringify(state)).not.toContain(project.root);
    await fixture.runtime.dispose();
  });

  it("closes the previous project and cancels its tasks before switching", async () => {
    // Verify that switching waits for old project tasks before publishing the new session.
    // 1. Open two projects and start a cancellable task under the first project.
    // 2. Switch to the second project and wait for the first task to observe cancellation.
    // 3. Confirm that memory and persisted state both reference only the second project.
    const fixture = await createRuntimeFixture();
    const first = await fixture.projectService.create(path.join(fixture.root, "first.cleo"), "甲");
    const second = await fixture.projectService.create(
      path.join(fixture.root, "second.cleo"),
      "乙",
    );
    await fixture.runtime.open(first.root);

    let observedProjectId = "";
    const task = fixture.runtime.startTask(async ({ projectId, signal }) => {
      // Record the bound project and resolve only after project shutdown cancels the task.
      observedProjectId = projectId;
      await new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return signal.aborted;
    });

    const switched = await fixture.runtime.open(second.root);

    await expect(task.promise).resolves.toBe(true);
    expect(observedProjectId).toBe(first.manifest.id);
    expect(switched).toMatchObject({ status: "open", project: { id: second.manifest.id } });
    expect((await fixture.appStateService.read()).currentProject).toBe(second.root);
    await fixture.runtime.dispose();
  });

  it("keeps no project active when a switch target is invalid", async () => {
    // Verify that a failed switch cannot retain the previous project as an active session.
    const fixture = await createRuntimeFixture();
    const project = await fixture.projectService.create(path.join(fixture.root, "valid.cleo"));
    await fixture.runtime.open(project.root);

    await expect(
      fixture.runtime.open(path.join(fixture.root, "missing.cleo")),
    ).rejects.toMatchObject({
      code: "PROJECT_NOT_FOUND",
    });

    expect(fixture.runtime.getState()).toEqual({ status: "closed" });
    expect((await fixture.appStateService.read()).currentProject).toBeNull();
  });

  it("restores the last project and clears a stale project reference", async () => {
    // Verify successful restoration and removal of a remembered path that no longer exists.
    const fixture = await createRuntimeFixture();
    const project = await fixture.projectService.create(path.join(fixture.root, "restore.cleo"));
    await fixture.appStateService.setCurrentProject(project.root);

    await expect(fixture.runtime.restorePreviousProject()).resolves.toMatchObject({
      status: "open",
      project: { id: project.manifest.id },
    });
    await fixture.runtime.close();
    await fixture.appStateService.setCurrentProject(path.join(fixture.root, "gone.cleo"));

    await expect(fixture.runtime.restorePreviousProject()).rejects.toMatchObject({
      code: "PROJECT_NOT_FOUND",
    });
    expect((await fixture.appStateService.read()).currentProject).toBeNull();
  });

  it("releases resources on application exit while remembering the last project", async () => {
    // Verify that application disposal closes resources without clearing restart state.
    const fixture = await createRuntimeFixture();
    const project = await fixture.projectService.create(path.join(fixture.root, "remember.cleo"));
    await fixture.runtime.open(project.root);

    await fixture.runtime.dispose();

    expect(fixture.runtime.getState()).toEqual({ status: "closed" });
    expect((await fixture.appStateService.read()).currentProject).toBe(project.root);
  });

  it("runs chat operations with only the active project's services", async () => {
    // Verify the runtime exposes project-scoped chat capabilities without model configuration.
    const fixture = await createRuntimeFixture();
    const project = await fixture.projectService.create(path.join(fixture.root, "chat.cleo"));
    await fixture.runtime.open(project.root);

    const result = await fixture.runtime.runChatTask(
      async ({ projectId, signal, chat, conversations }) => ({
        projectId,
        aborted: signal.aborted,
        canSend: typeof chat.send === "function",
        canReadHistory: typeof conversations.getRecentHistory === "function",
      }),
    );

    expect(result).toEqual({
      projectId: project.manifest.id,
      aborted: false,
      canSend: true,
      canReadHistory: true,
    });
    await fixture.runtime.dispose();
  });

  it("returns only stable error fields across the desktop boundary", () => {
    // Verify that unexpected errors are reduced to stable public fields without private paths.
    const safeError = toDesktopOperationError(new Error("D:\\private\\secret.txt"));

    expect(safeError).toEqual({
      code: "INTERNAL_ERROR",
      message: "发生未预期的内部错误。",
    });
    expect(safeError).not.toHaveProperty("stack");
    expect(safeError).not.toHaveProperty("details");
  });
});

async function createRuntimeFixture(): Promise<{
  root: string;
  runtime: DesktopProjectRuntime;
  projectService: ProjectService;
  appStateService: AppStateService;
}> {
  // Create isolated project, state, and runtime services for one lifecycle test.
  const root = await mkdtemp(path.join(tmpdir(), "cleodoc-desktop-project-"));
  temporaryDirectories.push(root);
  const appStateService = new AppStateService({ CLEODOC_HOME: path.join(root, "app-state") });
  return {
    root,
    appStateService,
    projectService: new ProjectService(TEST_DATABASE_OPTIONS),
    runtime: new DesktopProjectRuntime({
      ...TEST_DATABASE_OPTIONS,
      appStateService,
      chat: {
        maxToolRounds: TEST_CHAT_OPTIONS.maxToolRounds,
        defaultContextBudgetPolicy: TEST_CHAT_OPTIONS.defaultContextBudgetPolicy,
        compaction: TEST_CHAT_OPTIONS.compaction,
      },
    }),
  };
}
