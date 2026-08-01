import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AppError } from "../../contracts/src/index.js";
import { DocumentService } from "./document-service.js";
import { ProjectService } from "./project-service.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("ProjectService and DocumentService", () => {
  it("creates a portable project with a healthy SQLite database", async () => {
    const directory = await createTemporaryDirectory();
    const project = await new ProjectService().create(
      path.join(directory, "novel.cleo"),
      "测试小说",
    );

    const manifest = JSON.parse(
      await readFile(path.join(project.root, "cleo.project.json"), "utf8"),
    ) as { name: string };
    const status = await new ProjectService().status(project.root);

    expect(manifest.name).toBe("测试小说");
    expect(status.database).toBe("ok");
    expect(status.documentCount).toBe(0);
  });

  it("saves, reads, lists and deletes Markdown documents", async () => {
    const directory = await createTemporaryDirectory();
    const project = await new ProjectService().create(path.join(directory, "novel.cleo"));
    const documents = new DocumentService(project.root);

    const saved = await documents.save("manuscript/chapter-001.md", "# 第一章\n\n雨夜。\n");
    const read = await documents.read(saved.id);

    expect(saved.created).toBe(true);
    expect(read.content).toContain("雨夜");
    expect(await documents.list()).toHaveLength(1);

    await expect(
      documents.save("manuscript/chapter-001.md", "未经确认的覆盖"),
    ).rejects.toMatchObject({ code: "DOCUMENT_ALREADY_EXISTS" });

    const overwritten = await documents.save(
      "manuscript/chapter-001.md",
      "# 第一章\n\n天亮了。\n",
      true,
    );
    expect(overwritten.created).toBe(false);
    expect((await documents.read(overwritten.id)).content).toContain("天亮了");

    await documents.delete(overwritten.id);
    expect(await documents.list()).toHaveLength(0);
  });

  it("rejects paths outside manuscript and project", async () => {
    const directory = await createTemporaryDirectory();
    const project = await new ProjectService().create(path.join(directory, "novel.cleo"));
    const documents = new DocumentService(project.root);

    for (const unsafePath of ["../escape.md", "manuscript/../../escape.md", "C:\\escape.md"]) {
      await expect(documents.save(unsafePath, "unsafe")).rejects.toBeInstanceOf(AppError);
    }
  });
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "cleodoc-project-test-"));
  temporaryDirectories.push(directory);
  return directory;
}
