import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { KnowledgeToolService, MaterialService } from "../../../knowledge/src/index.js";
import { DocumentService, ProjectService } from "../../../project/src/index.js";
import {
  createTestMaterialOptions,
  TEST_DATABASE_OPTIONS,
} from "../../../../test/runtime-options.js";
import {
  ListMaterialsTool,
  ReadMaterialContextTool,
  SearchKnowledgeTool,
} from "./knowledge-tools.js";
import { ProjectToolCatalog } from "./project-tool-catalog.js";
import { ProjectToolRuntime } from "./project-tool-runtime.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("knowledge tools", () => {
  it("returns simple language-aware evidence and bounded source context", async () => {
    const fixture = await createFixture();
    const context = { projectId: fixture.projectId, conversationId: "conversation-1" };
    try {
      const listTool = new ListMaterialsTool(fixture.knowledge);
      const list = await listTool.execute({}, context);
      expect(list).toMatchObject({
        ok: true,
        data: {
          page: 1,
          totalPages: 1,
          materials: [
            {
              source: fixture.sourceId,
              title: "English Railway Notes",
              format: "text",
              languages: ["en"],
              indexStatus: "ready",
            },
          ],
        },
      });

      const searchTool = new SearchKnowledgeTool(fixture.knowledge);
      expect(
        searchTool.inputSchema.safeParse({ query: "railway", projectId: fixture.projectId })
          .success,
      ).toBe(false);
      await expect(
        searchTool.execute(
          { query: "railway", source: fixture.sourceId },
          { projectId: "another-project", conversationId: "conversation-1" },
        ),
      ).rejects.toMatchObject({ code: "MATERIAL_NOT_FOUND" });
      const mismatch = await searchTool.execute(
        { query: "铁路时刻", source: fixture.sourceId },
        context,
      );
      expect(mismatch).toMatchObject({
        ok: true,
        data: {
          queryLanguage: "zh",
          sourceLanguages: ["en"],
          languageWarning: "资料是英文的，请使用英文 query 重新搜索。",
        },
      });

      const search = await searchTool.execute(
        { query: "railway timetable", source: fixture.sourceId },
        context,
      );
      expect(search.ok).toBe(true);
      if (!search.ok) return;
      expect(search.data.languageWarning).toBeNull();
      expect(search.data.results[0]).toMatchObject({
        source: fixture.sourceId,
        title: "English Railway Notes",
        content: expect.stringContaining("railway timetable"),
      });
      expect(JSON.stringify(search.data)).not.toMatch(
        /contentHash|sourceRevision|vectorDistance|rank/,
      );

      const target = search.data.results[0]!;
      const readTool = new ReadMaterialContextTool(fixture.knowledge);
      const read = await readTool.execute(
        { source: target.source, chunkId: target.chunkId, before: 0, after: 0 },
        context,
      );
      expect(read).toMatchObject({
        ok: true,
        data: {
          source: fixture.sourceId,
          targetChunkId: target.chunkId,
          chunks: [{ chunkId: target.chunkId, content: target.content }],
        },
      });

      const compacted = searchTool.getCompactionMessage(
        { query: "railway timetable", source: fixture.sourceId },
        search,
      );
      expect(compacted).not.toContain("railway timetable");
      expect(compacted).not.toContain(target.chunkId);
      expect(compacted).not.toContain(target.content);
      expect(listTool.getCompactionMessage({}, list)).not.toContain("English Railway Notes");
      expect(
        readTool.getCompactionMessage(
          { source: target.source, chunkId: target.chunkId, before: 0, after: 0 },
          read,
        ),
      ).not.toContain(target.content);
    } finally {
      await fixture.knowledge.close();
    }
  });

  it("exposes search and list immediately but loads context reading through the catalog", async () => {
    const fixture = await createFixture();
    try {
      const catalog = ProjectToolCatalog.create({
        documents: new DocumentService(fixture.projectRoot),
        knowledge: fixture.knowledge,
      });
      const runtime = new ProjectToolRuntime(
        { projectId: fixture.projectId, conversationId: "conversation-1" },
        catalog,
      );
      expect(runtime.toolInfo.definitions.map((tool) => tool.name)).toEqual(
        expect.arrayContaining(["project_tool_catalog", "search_knowledge", "list_materials"]),
      );
      expect(runtime.toolInfo.definitions.map((tool) => tool.name)).not.toContain(
        "read_material_context",
      );

      await runtime.execute({
        id: "load-context-tool",
        name: "project_tool_catalog",
        argumentsJson: JSON.stringify({ action: "get", name: "read_material_context" }),
      });
      expect(runtime.toolInfo.definitions.map((tool) => tool.name)).toContain(
        "read_material_context",
      );
    } finally {
      await fixture.knowledge.close();
    }
  });
});

async function createFixture(): Promise<{
  projectRoot: string;
  projectId: string;
  sourceId: string;
  knowledge: KnowledgeToolService;
}> {
  const directory = await mkdtemp(path.join(tmpdir(), "cleodoc-knowledge-tools-test-"));
  temporaryDirectories.push(directory);
  const project = await new ProjectService(TEST_DATABASE_OPTIONS).create(
    path.join(directory, "novel.cleo"),
  );
  const options = {
    ...createTestMaterialOptions(),
    languageDetection: { minBlockUnits: 5 },
  };
  const materials = await MaterialService.open(project.root, options);
  const text = Array.from(
    { length: 12 },
    () => "The railway timetable records every station and departure time for the night train.",
  ).join(" ");
  const imported = await materials.addText(text, {
    title: "English Railway Notes",
    format: "text",
  });
  await materials.close();
  return {
    projectRoot: project.root,
    projectId: project.manifest.id,
    sourceId: imported.source.id,
    knowledge: await KnowledgeToolService.open(project.root, options),
  };
}
