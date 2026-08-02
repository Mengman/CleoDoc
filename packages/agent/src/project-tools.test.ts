import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ProjectDatabase, ProjectInstructionRepository } from "../../database/src/index.js";
import { DocumentService, ProjectService } from "../../project/src/index.js";
import { ProjectToolRuntime } from "./project-tools.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("ProjectToolRuntime", () => {
  it("lists and reads project documents without approval", async () => {
    const project = await createProject();
    const documents = new DocumentService(project.root);
    await documents.save("manuscript/notes.md", "# 资料\n\n雨夜车站。\n");
    const tools = new ProjectToolRuntime(project.root);

    const listed = parseResult(
      await tools.execute({ id: "list-1", name: "list_project_documents", argumentsJson: "{}" }),
    );
    expect(listed).toMatchObject({
      ok: true,
      documents: [{ path: "manuscript/notes.md" }],
    });

    const read = parseResult(
      await tools.execute({
        id: "read-1",
        name: "read_project_document",
        argumentsJson: JSON.stringify({ document: "manuscript/notes.md", maxCharacters: 4 }),
      }),
    );
    expect(read).toMatchObject({
      ok: true,
      document: { path: "manuscript/notes.md", content: "# 资料", truncated: true },
    });
  });

  it("requires approval for every write and explicit overwrite intent", async () => {
    const project = await createProject();
    const documents = new DocumentService(project.root);
    const deniedTools = new ProjectToolRuntime(project.root);

    const denied = parseResult(await deniedTools.execute(writeCall("初稿", false)));
    expect(denied).toMatchObject({ ok: false, error: { code: "USER_APPROVAL_REQUIRED" } });
    expect(await documents.list()).toHaveLength(0);

    const approvedTools = new ProjectToolRuntime(project.root, { approve: async () => true });
    expect(parseResult(await approvedTools.execute(writeCall("初稿", false)))).toMatchObject({
      ok: true,
      document: { path: "manuscript/summary.md", created: true },
    });
    expect((await documents.read("manuscript/summary.md")).content).toBe("初稿");

    const missingOverwriteIntent = parseResult(
      await approvedTools.execute(writeCall("改稿", false)),
    );
    expect(missingOverwriteIntent).toMatchObject({
      ok: false,
      error: { code: "DOCUMENT_ALREADY_EXISTS" },
    });
    expect((await documents.read("manuscript/summary.md")).content).toBe("初稿");

    expect(parseResult(await approvedTools.execute(writeCall("改稿", true)))).toMatchObject({
      ok: true,
      document: { created: false },
    });
    expect((await documents.read("manuscript/summary.md")).content).toBe("改稿");
  });

  it("rejects paths outside the project manuscript directory", async () => {
    const project = await createProject();
    const tools = new ProjectToolRuntime(project.root, { approve: async () => true });
    const result = parseResult(
      await tools.execute({
        id: "write-unsafe",
        name: "write_project_document",
        argumentsJson: JSON.stringify({ path: "../escape.md", content: "unsafe" }),
      }),
    );

    expect(result).toMatchObject({ ok: false });
    expect(await new DocumentService(project.root).list()).toHaveLength(0);
  });

  it("reads project instructions freely and requires approval for revisioned writes", async () => {
    const project = await createProject();
    const database = await ProjectDatabase.open(project.root);
    const repository = new ProjectInstructionRepository(database);
    const approvals: string[] = [];
    const tools = new ProjectToolRuntime(project.root, {
      projectInstructions: repository,
      approve: async (request) => {
        approvals.push(request.toolName);
        return true;
      },
    });
    try {
      expect(
        parseResult(
          await tools.execute({
            id: "read-r0",
            name: "read_project_instructions",
            argumentsJson: "{}",
          }),
        ),
      ).toMatchObject({ ok: true, projectInstructions: { revision: 0, content: "" } });

      expect(
        parseResult(
          await tools.execute({
            id: "set-r1",
            name: "set_project_instructions",
            argumentsJson: JSON.stringify({ content: "保持第三人称限知", expected_revision: 0 }),
          }),
        ),
      ).toMatchObject({ ok: true, projectInstructions: { revision: 1 } });
      expect(repository.getCurrent()?.content).toBe("保持第三人称限知");
      expect(approvals).toEqual(["set_project_instructions"]);

      const stale = parseResult(
        await tools.execute({
          id: "stale",
          name: "append_project_instructions",
          argumentsJson: JSON.stringify({ text: "\n避免全知视角", expected_revision: 0 }),
        }),
      );
      expect(stale).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
      expect(repository.getCurrent()?.content).toBe("保持第三人称限知");
    } finally {
      await database.close();
    }
  });
});

function writeCall(content: string, overwrite: boolean) {
  return {
    id: "write-1",
    name: "write_project_document",
    argumentsJson: JSON.stringify({ path: "manuscript/summary.md", content, overwrite }),
  };
}

function parseResult(value: string): Record<string, unknown> {
  return JSON.parse(value) as Record<string, unknown>;
}

async function createProject() {
  const directory = await mkdtemp(path.join(tmpdir(), "cleodoc-tools-test-"));
  temporaryDirectories.push(directory);
  return await new ProjectService().create(path.join(directory, "novel.cleo"));
}
