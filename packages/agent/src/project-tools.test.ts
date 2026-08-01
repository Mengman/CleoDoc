import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

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
