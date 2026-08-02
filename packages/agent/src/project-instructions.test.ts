import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ProjectService } from "../../project/src/index.js";
import { ChatService } from "./chat-service.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("database-native project instructions", () => {
  it("does not load an AGENTS.md file from the writing project", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cleodoc-file-instructions-test-"));
    temporaryDirectories.push(directory);
    const project = await new ProjectService().create(path.join(directory, "novel.cleo"));
    await writeFile(path.join(project.root, "AGENTS.md"), "不应加载的文件规则", "utf8");

    const chat = await ChatService.open(project.root);
    try {
      expect(chat.getProjectInstructions()).toBeNull();
    } finally {
      await chat.close();
    }
  });
});
