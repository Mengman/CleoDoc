import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AppError } from "../../contracts/src/index.js";
import { DocumentService } from "./document-service.js";
import { ProjectService } from "./project-service.js";
import { TEST_DATABASE_OPTIONS } from "../../../test/runtime-options.js";

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
    const project = await new ProjectService(TEST_DATABASE_OPTIONS).create(
      path.join(directory, "novel.cleo"),
      "测试小说",
    );

    const manifest = JSON.parse(
      await readFile(path.join(project.root, "cleo.project.json"), "utf8"),
    ) as { name: string };
    const status = await new ProjectService(TEST_DATABASE_OPTIONS).status(project.root);

    expect(manifest.name).toBe("测试小说");
    expect(status.database).toBe("ok");
    expect(status.documentCount).toBe(0);
  });

  it("saves, reads, lists and deletes Markdown documents", async () => {
    const directory = await createTemporaryDirectory();
    const project = await new ProjectService(TEST_DATABASE_OPTIONS).create(
      path.join(directory, "novel.cleo"),
    );
    const documents = new DocumentService(project.root);

    const saved = await documents.save("manuscript/chapter-001.md", "# 第一章\n\n雨夜。\n");
    const read = await documents.read(saved.relativePath);

    expect(saved.created).toBe(true);
    expect(saved).not.toHaveProperty("id");
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
    expect((await documents.read(overwritten.relativePath)).content).toContain("天亮了");

    await documents.delete(overwritten.relativePath);
    expect(await documents.list()).toHaveLength(0);
  });

  it("lists and reads nested Markdown and plain-text manuscripts without making TXT writable", async () => {
    // Verify the desktop read model without broadening the existing Markdown mutation contract.
    // 1. Create nested Markdown, TXT, and unsupported manuscript files.
    // 2. Confirm the read-only list and reader expose only the two supported formats.
    // 3. Confirm the original document API still treats TXT as read-only external content.
    const directory = await createTemporaryDirectory();
    const project = await new ProjectService(TEST_DATABASE_OPTIONS).create(
      path.join(directory, "novel.cleo"),
    );
    const nestedDirectory = path.join(project.root, "manuscript", "volume-01");
    await mkdir(nestedDirectory, { recursive: true });
    await Promise.all([
      writeFile(path.join(project.root, "manuscript", "chapter-001.md"), "# 第一章\n\n潮声。\n"),
      writeFile(path.join(nestedDirectory, "chapter-002.txt"), "第二章\n灯塔亮了。\n"),
      writeFile(path.join(nestedDirectory, "notes.json"), '{"ignored":true}\n'),
    ]);

    const readable = await new DocumentService(project.root).listReadableDocuments();
    expect(readable.map((document) => document.relativePath)).toEqual([
      "manuscript/chapter-001.md",
      "manuscript/volume-01/chapter-002.txt",
    ]);
    expect(
      (await new DocumentService(project.root).list()).map((document) => document.relativePath),
    ).toEqual(["manuscript/chapter-001.md"]);

    const documents = new DocumentService(project.root);
    expect((await documents.readReadableDocument("chapter-001.md")).content).toContain("潮声");
    expect((await documents.readReadableDocument("volume-01/chapter-002.txt")).content).toContain(
      "灯塔亮了",
    );
    await expect(documents.read("volume-01/chapter-002.txt")).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    await expect(documents.save("volume-01/new.txt", "不可写入")).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });

  it("rejects paths outside manuscript and project", async () => {
    const directory = await createTemporaryDirectory();
    const project = await new ProjectService(TEST_DATABASE_OPTIONS).create(
      path.join(directory, "novel.cleo"),
    );
    const documents = new DocumentService(project.root);

    for (const unsafePath of ["../escape.md", "manuscript/../../escape.md", "C:\\escape.md"]) {
      await expect(documents.save(unsafePath, "unsafe")).rejects.toBeInstanceOf(AppError);
      await expect(documents.readReadableDocument(unsafePath)).rejects.toBeInstanceOf(AppError);
    }
  });
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "cleodoc-project-test-"));
  temporaryDirectories.push(directory);
  return directory;
}
