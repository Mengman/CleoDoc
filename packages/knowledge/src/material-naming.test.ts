import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ProjectService } from "../../project/src/index.js";
import { MaterialService } from "./material-service.js";
import { materialFormatFromPath } from "./material-validation.js";
import { TEST_DATABASE_OPTIONS, TEST_MATERIAL_OPTIONS } from "../../../test/runtime-options.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("MaterialService material naming", () => {
  it("detects the material format after trimming the file name", () => {
    expect(materialFormatFromPath(path.join("input", "资料.md  "))).toBe("markdown");
    expect(materialFormatFromPath(path.join("input", "资料.txt\t"))).toBe("text");
  });

  it("preserves imported TXT and Markdown file names and formats", async () => {
    const directory = await createTemporaryDirectory();
    const project = await new ProjectService(TEST_DATABASE_OPTIONS).create(
      path.join(directory, "novel.cleo"),
    );
    const markdownPath = path.join(directory, "研究资料.MARKDOWN");
    const textPath = path.join(directory, "  人物笔记.txt");
    await writeFile(markdownPath, "# 研究资料\n\nMarkdown 正文。\n", "utf8");
    await writeFile(textPath, "人物住在旧城。\n", "utf8");
    const service = await MaterialService.open(project.root, TEST_MATERIAL_OPTIONS);

    try {
      const markdown = await service.addFile(markdownPath);
      const text = await service.addFile(textPath);

      expect(markdown.source).toMatchObject({
        format: "markdown",
        originalFileName: "研究资料.MARKDOWN",
        relativePath: "materials/研究资料.MARKDOWN",
      });
      expect(text.source).toMatchObject({
        format: "text",
        originalFileName: "人物笔记.txt",
        relativePath: "materials/人物笔记.txt",
      });
      expect(await readFile(path.join(project.root, markdown.source.relativePath), "utf8")).toBe(
        "# 研究资料\n\nMarkdown 正文。\n",
      );
      expect(await readFile(path.join(project.root, text.source.relativePath), "utf8")).toBe(
        "人物住在旧城。\n",
      );
    } finally {
      await service.close();
    }
  });

  it("rejects duplicate titles for file and pasted materials", async () => {
    const directory = await createTemporaryDirectory();
    const project = await new ProjectService(TEST_DATABASE_OPTIONS).create(
      path.join(directory, "novel.cleo"),
    );
    const firstPath = path.join(directory, "first.txt");
    const secondPath = path.join(directory, "second.txt");
    await writeFile(firstPath, "第一份资料。", "utf8");
    await writeFile(secondPath, "第二份资料。", "utf8");
    const service = await MaterialService.open(project.root, TEST_MATERIAL_OPTIONS);

    try {
      await service.addFile(firstPath, { title: "共同名称" });
      await expect(service.addFile(secondPath, { title: " 共同名称 " })).rejects.toMatchObject({
        code: "MATERIAL_ALREADY_EXISTS",
      });
      await expect(service.addText("粘贴资料。", { title: "共同名称" })).rejects.toMatchObject({
        code: "MATERIAL_ALREADY_EXISTS",
      });
      await expect(
        readFile(path.join(project.root, "materials", "second.txt"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(await service.list()).toHaveLength(1);
    } finally {
      await service.close();
    }
  });

  it("does not overwrite an existing project file with the same original name", async () => {
    const directory = await createTemporaryDirectory();
    const project = await new ProjectService(TEST_DATABASE_OPTIONS).create(
      path.join(directory, "novel.cleo"),
    );
    const inputPath = path.join(directory, "archive", "资料.md");
    await writeFile(path.join(project.root, "materials", "资料.md"), "项目中的既有文件。", "utf8");
    await mkdir(path.dirname(inputPath), { recursive: true });
    await writeFile(inputPath, "准备导入的新文件。", "utf8");
    const service = await MaterialService.open(project.root, TEST_MATERIAL_OPTIONS);

    try {
      await expect(service.addFile(inputPath, { title: "新资料" })).rejects.toMatchObject({
        code: "MATERIAL_ALREADY_EXISTS",
      });
      expect(await readFile(path.join(project.root, "materials", "资料.md"), "utf8")).toBe(
        "项目中的既有文件。",
      );
      expect(await service.list()).toEqual([]);
    } finally {
      await service.close();
    }
  });

  it("rejects rename conflicts without changing files or indexes", async () => {
    const directory = await createTemporaryDirectory();
    const project = await new ProjectService(TEST_DATABASE_OPTIONS).create(
      path.join(directory, "novel.cleo"),
    );
    const service = await MaterialService.open(project.root, TEST_MATERIAL_OPTIONS);

    try {
      const first = await service.addText("钟楼里藏着第一条线索。", { title: "钟楼资料" });
      await service.addText("旧车票是第二条线索。", { title: "车票资料" });
      await service.embedIndex();
      const chunkIds = (await service.search("钟楼")).map((chunk) => chunk.chunkId);

      await expect(service.rename(first.source.id, "车票资料")).rejects.toMatchObject({
        code: "MATERIAL_ALREADY_EXISTS",
      });
      const renamed = await service.rename(first.source.id, "钟楼档案");

      expect(renamed).toMatchObject({
        relativePath: first.source.relativePath,
        contentHash: first.source.contentHash,
        title: "钟楼档案",
      });
      expect((await service.search("钟楼")).map((chunk) => chunk.chunkId)).toEqual(chunkIds);
      await expect(service.embedIndex()).resolves.toMatchObject({
        processedChunks: 0,
        skippedChunks: 2,
      });
    } finally {
      await service.close();
    }
  });
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "cleodoc-material-naming-test-"));
  temporaryDirectories.push(directory);
  return directory;
}
