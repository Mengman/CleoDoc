import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MaterialRepository, ProjectDatabase } from "../../database/src/index.js";
import { ProjectService } from "../../project/src/index.js";
import { MaterialService } from "./material-service.js";
import {
  createTestMaterialOptions,
  TEST_DATABASE_OPTIONS,
  TEST_MATERIAL_OPTIONS,
} from "../../../test/runtime-options.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("MaterialService", () => {
  it("imports TXT and Markdown into portable facts and rejects duplicate content", async () => {
    const directory = await createTemporaryDirectory();
    const project = await new ProjectService(TEST_DATABASE_OPTIONS).create(
      path.join(directory, "novel.cleo"),
    );
    const inputPath = path.join(directory, "民国铁路.md");
    await writeFile(inputPath, "# 铁路资料\n\n夜间列车使用煤油灯。\n", "utf8");
    const service = await MaterialService.open(project.root, TEST_MATERIAL_OPTIONS);

    try {
      const imported = await service.addFile(inputPath, {
        title: "铁路照明资料",
        sourceLabel: "地方志摘录",
        tags: ["历史", "铁路", "历史"],
      });
      expect(imported.created).toBe(true);
      expect(imported.source).toMatchObject({
        projectId: project.manifest.id,
        origin: "file",
        format: "markdown",
        title: "铁路照明资料",
        sourceLabel: "地方志摘录",
        originalFileName: "民国铁路.md",
        tags: ["历史", "铁路"],
      });
      expect(
        await readFile(path.join(project.root, imported.source.relativePath), "utf8"),
      ).toContain("煤油灯");
      const metadata = JSON.parse(
        await readFile(
          path.join(project.root, "sources", "metadata", `${imported.source.id}.json`),
          "utf8",
        ),
      ) as { contentHash: string };
      expect(metadata.contentHash).toBe(imported.source.contentHash);
      const derivedCdm = await readFile(
        path.join(project.root, ".cleo", "derived", "documents", `${imported.source.id}.cdm.xml`),
        "utf8",
      );
      expect(derivedCdm).toContain("<h1");
      expect(derivedCdm).toContain("铁路资料");
      expect(derivedCdm).toContain("夜间列车使用煤油灯。");
      const chunkPreview = JSON.parse(
        await readFile(
          path.join(
            project.root,
            ".cleo",
            "derived",
            "chunks",
            `${imported.source.id}.chunks.json`,
          ),
          "utf8",
        ),
      ) as {
        sourceId: string;
        sourceHash: string;
        chunkerVersion: string;
        config: {
          tokenizerModelId: string;
          tokenizerRevision: string;
          maxInputTokens: number;
          splitSearchWindowRatio: number;
        };
        chunks: Array<{
          content: string;
          tokenCount: number;
          startOffset: number;
          endOffset: number;
        }>;
      };
      expect(chunkPreview).toMatchObject({
        sourceId: imported.source.id,
        sourceHash: imported.source.contentHash,
        chunkerVersion: "structural-baseline-v1",
        config: {
          tokenizerModelId: "test-zh-tokenizer",
          tokenizerRevision: "test-v1",
          maxInputTokens: 800,
          splitSearchWindowRatio: 0.75,
        },
      });
      expect(chunkPreview.chunks).toEqual([
        expect.objectContaining({
          content: "铁路资料\n\n夜间列车使用煤油灯。",
          tokenCount: expect.any(Number),
          startOffset: 0,
          endOffset: Buffer.byteLength("# 铁路资料\n\n夜间列车使用煤油灯。", "utf8"),
        }),
      ]);
      expect(await service.getIndexStatus()).toEqual([
        expect.objectContaining({
          sourceId: imported.source.id,
          status: "ready",
          chunkCount: 1,
          parserVersion: "document-ingestion-v1",
          chunkerVersion: "structural-baseline-v1",
        }),
      ]);
      expect(await service.search("煤油灯")).toEqual([
        expect.objectContaining({
          sourceId: imported.source.id,
          sourceTitle: "铁路照明资料",
          content: "铁路资料\n\n夜间列车使用煤油灯。",
        }),
      ]);
      expect(await service.search("铁路")).toHaveLength(1);

      const duplicatePath = path.join(directory, "copy.md");
      await writeFile(duplicatePath, "# 铁路资料\n\n夜间列车使用煤油灯。\n", "utf8");
      const duplicate = await service.addFile(duplicatePath);
      expect(duplicate).toEqual({
        source: imported.source,
        created: false,
        inputEncoding: "utf-8",
      });
      expect(await service.list()).toHaveLength(1);
    } finally {
      await service.close();
    }
  });

  it("detects GB2312-compatible files and stores a normalized UTF-8 project copy", async () => {
    const directory = await createTemporaryDirectory();
    const project = await new ProjectService(TEST_DATABASE_OPTIONS).create(
      path.join(directory, "novel.cleo"),
    );
    const inputPath = path.join(directory, "旧城资料.md");
    await writeFile(
      inputPath,
      Buffer.from("2320d6d0cec4d7cac1cf0a0abec9b3c7b3b5d5bea1a30a", "hex"),
    );
    const service = await MaterialService.open(project.root, TEST_MATERIAL_OPTIONS);

    try {
      const imported = await service.addFile(inputPath);
      expect(imported.inputEncoding).toBe("gb18030");
      expect((await service.get(imported.source.id)).content).toBe("# 中文资料\n\n旧城车站。\n");
      expect(
        await readFile(
          path.join(project.root, ".cleo", "derived", "documents", `${imported.source.id}.cdm.xml`),
          "utf8",
        ),
      ).toContain("旧城车站。");
    } finally {
      await service.close();
    }
  });

  it("detects and persists ordered source languages", async () => {
    const directory = await createTemporaryDirectory();
    const project = await new ProjectService(TEST_DATABASE_OPTIONS).create(
      path.join(directory, "novel.cleo"),
    );
    const service = await MaterialService.open(project.root, TEST_MATERIAL_OPTIONS);
    const english = Array.from({ length: 70 }, (_, index) => `evidence${index}`).join(" ");
    const chinese =
      "这是一段用于资料语言检测的中文正文，其中包含足够多的连续汉字，用来确认主要语言排序能够稳定保存。".repeat(
        3,
      );

    try {
      const englishSource = await service.addText(english, { title: "English source" });
      expect(englishSource.source.languages).toEqual(["en"]);
      const englishPreview = JSON.parse(
        await readFile(
          path.join(
            project.root,
            ".cleo",
            "derived",
            "chunks",
            `${englishSource.source.id}.chunks.json`,
          ),
          "utf8",
        ),
      ) as { config: { tokenizerModelId: string } };
      expect(englishPreview.config.tokenizerModelId).toBe("test-en-tokenizer");

      const bilingualSource = await service.addText(`${chinese}\n${english}`, {
        title: "双语资料",
      });
      expect(bilingualSource.source.languages).toEqual(["zh", "en"]);
      expect(
        (await service.list()).find((source) => source.id === bilingualSource.source.id),
      ).toEqual(bilingualSource.source);
      const metadata = JSON.parse(
        await readFile(
          path.join(project.root, "sources", "metadata", `${bilingualSource.source.id}.json`),
          "utf8",
        ),
      ) as { languages: string[] };
      expect(metadata.languages).toEqual(["zh", "en"]);
    } finally {
      await service.close();
    }
  });

  it("adds pasted text, renames it and removes both facts and SQLite projection", async () => {
    const directory = await createTemporaryDirectory();
    const project = await new ProjectService(TEST_DATABASE_OPTIONS).create(
      path.join(directory, "novel.cleo"),
    );
    const service = await MaterialService.open(project.root, TEST_MATERIAL_OPTIONS);
    let materialId: string;
    let relativePath: string;

    try {
      const added = await service.addText("车站只有一个出口。", {
        title: "场景笔记",
        tags: ["场景"],
      });
      materialId = added.source.id;
      relativePath = added.source.relativePath;
      const renamed = await service.rename(materialId, "车站场景笔记");
      expect(renamed.title).toBe("车站场景笔记");
      expect(renamed.relativePath).toBe(relativePath);
      expect((await service.get(materialId)).content).toBe("车站只有一个出口。");

      const removed = await service.remove(materialId);
      expect(removed.id).toBe(materialId);
      expect(await service.list()).toEqual([]);
      expect(await service.search("车站")).toEqual([]);
      await expect(readFile(path.join(project.root, relativePath), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(
        readFile(path.join(project.root, "sources", "metadata", `${materialId}.json`), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        readFile(
          path.join(project.root, ".cleo", "derived", "documents", `${materialId}.cdm.xml`),
          "utf8",
        ),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        readFile(
          path.join(project.root, ".cleo", "derived", "chunks", `${materialId}.chunks.json`),
          "utf8",
        ),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await service.close();
    }

    const database = await ProjectDatabase.open(project.root, TEST_DATABASE_OPTIONS);
    try {
      expect(new MaterialRepository(database).get(materialId)).toBeNull();
    } finally {
      await database.close();
    }
  });

  it("rebuilds a missing SQLite projection from metadata files", async () => {
    const directory = await createTemporaryDirectory();
    const project = await new ProjectService(TEST_DATABASE_OPTIONS).create(
      path.join(directory, "novel.cleo"),
    );
    const service = await MaterialService.open(project.root, TEST_MATERIAL_OPTIONS);
    const added = await service.addText("用于重建投影的资料。", { title: "投影测试" });
    await service.close();

    const database = await ProjectDatabase.open(project.root, TEST_DATABASE_OPTIONS);
    await new MaterialRepository(database).remove(added.source.id);
    expect(new MaterialRepository(database).get(added.source.id)).toBeNull();
    await database.close();

    const reopened = await MaterialService.open(project.root, TEST_MATERIAL_OPTIONS);
    try {
      expect(await reopened.list()).toEqual([added.source]);
    } finally {
      await reopened.close();
    }
  });

  it("rebuilds chunks and FTS without changing unchanged public chunk IDs", async () => {
    const directory = await createTemporaryDirectory();
    const project = await new ProjectService(TEST_DATABASE_OPTIONS).create(
      path.join(directory, "novel.cleo"),
    );
    const service = await MaterialService.open(
      project.root,
      createTestMaterialOptions({ maxInputTokens: 12 }),
    );
    try {
      await service.addText("第一条线索藏在钟楼。第二条线索来自旧车票。", {
        title: "案件线索",
      });
      const before = await service.search("线索");
      expect(before.length).toBeGreaterThan(1);

      const rebuilt = await service.rebuildIndex();
      await service.rebuildFts();
      expect(rebuilt).toEqual({ indexedCount: 1, failed: [] });
      const after = await service.search("线索");
      expect(after.map((chunk) => chunk.chunkId)).toEqual(before.map((chunk) => chunk.chunkId));
      expect((await service.getIndexStatus())[0]).toMatchObject({
        status: "ready",
        chunkCount: after.length,
      });
    } finally {
      await service.close();
    }
  });

  it("marks an index stale when the tokenizer revision changes", async () => {
    const directory = await createTemporaryDirectory();
    const project = await new ProjectService(TEST_DATABASE_OPTIONS).create(
      path.join(directory, "novel.cleo"),
    );
    const initial = await MaterialService.open(project.root, TEST_MATERIAL_OPTIONS);
    await initial.addText("城门在午夜关闭，守卫会记录所有出入者。", { title: "城门记录" });
    await initial.close();

    const changed = await MaterialService.open(
      project.root,
      createTestMaterialOptions({ modelRevision: "test-v2" }),
    );
    try {
      expect((await changed.getIndexStatus())[0]).toMatchObject({ status: "stale" });
      expect(await changed.search("守卫")).toEqual([]);
      expect(await changed.rebuildIndex()).toEqual({ indexedCount: 1, failed: [] });
      expect((await changed.getIndexStatus())[0]).toMatchObject({ status: "ready" });
      expect(await changed.search("守卫")).toHaveLength(1);
    } finally {
      await changed.close();
    }
  });

  it("embeds ready chunks by primary language and skips valid vectors on retry", async () => {
    const directory = await createTemporaryDirectory();
    const project = await new ProjectService(TEST_DATABASE_OPTIONS).create(
      path.join(directory, "novel.cleo"),
    );
    const service = await MaterialService.open(project.root, TEST_MATERIAL_OPTIONS);
    const progress: string[] = [];
    try {
      await service.addText("城门在午夜关闭，守卫会记录所有出入者。", { title: "城门记录" });
      await service.addText(
        Array.from({ length: 70 }, (_, index) => `evidence${index}`).join(" "),
        { title: "English evidence" },
      );

      const first = await service.embedIndex({
        onProgress: ({ modelId, chunkId }) => progress.push(`${modelId}:${chunkId}`),
      });
      expect(first).toMatchObject({
        totalChunks: 2,
        processedChunks: 2,
        skippedChunks: 0,
        writtenChunks: 2,
        discardedChunks: 0,
      });
      expect(first.models).toEqual([
        expect.objectContaining({ language: "zh", processedChunks: 1, writtenChunks: 1 }),
        expect.objectContaining({ language: "en", processedChunks: 1, writtenChunks: 1 }),
      ]);
      expect(progress).toHaveLength(2);

      await expect(service.embedIndex()).resolves.toMatchObject({
        totalChunks: 2,
        processedChunks: 0,
        skippedChunks: 2,
        writtenChunks: 0,
      });
      expect(await service.search("守卫")).toHaveLength(1);
    } finally {
      await service.close();
    }
  });

  it("keeps FTS available when embedding inference fails", async () => {
    const directory = await createTemporaryDirectory();
    const project = await new ProjectService(TEST_DATABASE_OPTIONS).create(
      path.join(directory, "novel.cleo"),
    );
    const baseOptions = createTestMaterialOptions();
    const service = await MaterialService.open(project.root, {
      ...baseOptions,
      embeddingModels: {
        ...baseOptions.embeddingModels,
        zh: {
          ...baseOptions.embeddingModels.zh,
          async runEmbeddingTask() {
            throw new Error("inference failed");
          },
        },
      },
    });
    try {
      await service.addText("旧地图标出了已经封闭的地下通道。", { title: "旧地图" });
      await expect(service.embedIndex()).rejects.toThrow("inference failed");
      expect(await service.search("地下通道")).toHaveLength(1);
      expect((await service.getIndexStatus())[0]).toMatchObject({ status: "ready" });
    } finally {
      await service.close();
    }
  });

  it("rejects unsupported and non-UTF-8 files", async () => {
    const directory = await createTemporaryDirectory();
    const project = await new ProjectService(TEST_DATABASE_OPTIONS).create(
      path.join(directory, "novel.cleo"),
    );
    const service = await MaterialService.open(project.root, TEST_MATERIAL_OPTIONS);
    try {
      const pdfPath = path.join(directory, "source.pdf");
      await writeFile(pdfPath, "not a pdf", "utf8");
      await expect(service.addFile(pdfPath)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

      const invalidPath = path.join(directory, "invalid.txt");
      await writeFile(invalidPath, Buffer.from([0xff, 0xfe, 0xfd]));
      await expect(service.addFile(invalidPath)).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
      });
    } finally {
      await service.close();
    }
  });

  it("keeps identical materials isolated between projects", async () => {
    const directory = await createTemporaryDirectory();
    const projectA = await new ProjectService(TEST_DATABASE_OPTIONS).create(
      path.join(directory, "a.cleo"),
    );
    const projectB = await new ProjectService(TEST_DATABASE_OPTIONS).create(
      path.join(directory, "b.cleo"),
    );
    const serviceA = await MaterialService.open(projectA.root, TEST_MATERIAL_OPTIONS);
    const serviceB = await MaterialService.open(projectB.root, TEST_MATERIAL_OPTIONS);
    try {
      const addedA = await serviceA.addText("两个项目都需要的年代资料。", { title: "年代" });
      const addedB = await serviceB.addText("两个项目都需要的年代资料。", { title: "年代" });

      expect(addedA.created).toBe(true);
      expect(addedB.created).toBe(true);
      expect(addedA.source.projectId).toBe(projectA.manifest.id);
      expect(addedB.source.projectId).toBe(projectB.manifest.id);
      expect(addedA.source.id).not.toBe(addedB.source.id);
      expect(await serviceA.list()).toEqual([addedA.source]);
      expect(await serviceB.list()).toEqual([addedB.source]);
    } finally {
      await serviceA.close();
      await serviceB.close();
    }
  });
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "cleodoc-material-test-"));
  temporaryDirectories.push(directory);
  return directory;
}
