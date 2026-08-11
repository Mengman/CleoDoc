import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ProjectService } from "../../project/src/index.js";
import { TEST_DATABASE_OPTIONS, TEST_MATERIAL_OPTIONS } from "../../../test/runtime-options.js";
import { KnowledgeToolService } from "./knowledge-tool-service.js";
import { MaterialService } from "./material-service.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("KnowledgeToolService title addressing", () => {
  it("lists, searches and reads material context without exposing source IDs", async () => {
    const directory = await createTemporaryDirectory();
    const project = await new ProjectService(TEST_DATABASE_OPTIONS).create(
      path.join(directory, "novel.cleo"),
    );
    const materials = await MaterialService.open(project.root, TEST_MATERIAL_OPTIONS);
    await materials.addText("The brass key is hidden inside the clock tower.", {
      title: "Clock Tower Notes",
    });
    await materials.addText("The railway timetable is stored at the station.", {
      title: "Railway Notes",
    });
    await materials.close();

    const service = await KnowledgeToolService.open(project.root, TEST_MATERIAL_OPTIONS);
    try {
      const listed = await service.listMaterialsByTitle({ projectId: project.manifest.id });
      expect(listed.materials).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ title: "Clock Tower Notes", indexStatus: "ready" }),
          expect.objectContaining({ title: "Railway Notes", indexStatus: "ready" }),
        ]),
      );
      expect(listed.materials[0]).not.toHaveProperty("sourceId");

      const searched = await service.searchKnowledgeByTitle({
        projectId: project.manifest.id,
        query: "brass key",
        title: " Clock Tower Notes ",
      });
      expect(searched.results).toHaveLength(1);
      expect(searched.results[0]).toMatchObject({
        title: "Clock Tower Notes",
        content: expect.stringContaining("brass key"),
      });
      expect(searched.results[0]).not.toHaveProperty("sourceId");

      const context = await service.readMaterialContextByTitle({
        projectId: project.manifest.id,
        title: "Clock Tower Notes",
        chunkId: searched.results[0]!.chunkId,
      });
      expect(context).toMatchObject({
        title: "Clock Tower Notes",
        targetChunkId: searched.results[0]!.chunkId,
      });
      expect(context).not.toHaveProperty("sourceId");
    } finally {
      await service.close();
    }
  });

  it("rejects unknown titles and chunk references from another material", async () => {
    const directory = await createTemporaryDirectory();
    const project = await new ProjectService(TEST_DATABASE_OPTIONS).create(
      path.join(directory, "novel.cleo"),
    );
    const materials = await MaterialService.open(project.root, TEST_MATERIAL_OPTIONS);
    await materials.addText("Clock tower evidence.", { title: "Clock Notes" });
    await materials.addText("Railway station evidence.", { title: "Railway Notes" });
    await materials.close();

    const service = await KnowledgeToolService.open(project.root, TEST_MATERIAL_OPTIONS);
    try {
      await expect(
        service.searchKnowledgeByTitle({
          projectId: project.manifest.id,
          query: "evidence",
          title: "Missing Notes",
        }),
      ).rejects.toMatchObject({ code: "MATERIAL_NOT_FOUND" });

      const railway = await service.searchKnowledgeByTitle({
        projectId: project.manifest.id,
        query: "railway",
        title: "Railway Notes",
      });
      await expect(
        service.readMaterialContextByTitle({
          projectId: project.manifest.id,
          title: "Clock Notes",
          chunkId: railway.results[0]!.chunkId,
        }),
      ).rejects.toMatchObject({ code: "CHUNK_SOURCE_MISMATCH" });
    } finally {
      await service.close();
    }
  });
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "cleodoc-knowledge-title-test-"));
  temporaryDirectories.push(directory);
  return directory;
}
