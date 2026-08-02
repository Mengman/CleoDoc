import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ConversationRepository,
  ProjectDatabase,
  ProjectInstructionRepository,
  SessionRepository,
} from "../../../database/src/index.js";
import { DocumentService, ProjectService } from "../../../project/src/index.js";
import { ProjectToolRuntime } from "./index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("ProjectToolRuntime", () => {
  it("returns versioned document results without hashes or internal IDs", async () => {
    const project = await createProject();
    const documents = new DocumentService(project.root);
    await documents.save("manuscript/notes.md", "# 资料\n\n雨夜车站。\n");
    const tools = new ProjectToolRuntime(project.root);

    const listed = await executeTool(tools, "list_project_documents", {});
    expect(listed).toMatchObject({
      ok: true,
      tool: { name: "list_project_documents", version: 1 },
      data: {
        documents: [
          {
            path: "manuscript/notes.md",
            size: expect.any(Number),
            updatedAt: expect.any(String),
          },
        ],
      },
    });
    expect(JSON.stringify(listed)).not.toContain("contentHash");
    expect(JSON.stringify(listed)).not.toContain('"id"');

    const read = await executeTool(tools, "read_project_document", {
      document: "manuscript/notes.md",
      maxCharacters: 4,
    });
    expect(read).toMatchObject({
      ok: true,
      tool: { name: "read_project_document", version: 1 },
      data: {
        document: {
          path: "manuscript/notes.md",
          content: "# 资料",
          truncated: true,
          updatedAt: expect.any(String),
        },
      },
    });
    expect(JSON.stringify(read)).not.toContain("contentHash");
  });

  it("requires approval and keeps allow-until-exit grants in memory", async () => {
    const project = await createProject();
    const documents = new DocumentService(project.root);
    let approvalCount = 0;
    const tools = new ProjectToolRuntime(project.root, {
      approve: async () => {
        approvalCount += 1;
        return "allow_until_exit";
      },
    });

    const created = await executeTool(tools, "write_project_document", {
      path: "manuscript/summary.md",
      content: "初稿",
    });
    expect(created).toMatchObject({
      ok: true,
      data: { document: { path: "manuscript/summary.md", created: true } },
    });

    const overwritten = await executeTool(tools, "write_project_document", {
      path: "manuscript/summary.md",
      content: "改稿",
      overwrite: true,
    });
    expect(overwritten).toMatchObject({
      ok: true,
      data: { document: { created: false } },
    });
    expect(approvalCount).toBe(1);
    expect((await documents.read("manuscript/summary.md")).content).toBe("改稿");
  });

  it("does not expose or execute hidden tools until get_tool loads them", async () => {
    const project = await createProject();
    const database = await ProjectDatabase.open(project.root);
    const repository = new ProjectInstructionRepository(database);
    const tools = new ProjectToolRuntime(project.root, {
      projectInstructions: repository,
      approve: async () => "allow_once",
    });
    try {
      expect(tools.definitions.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          "list_project_documents",
          "read_project_document",
          "write_project_document",
          "list_tools",
          "get_tool",
        ]),
      );
      expect(tools.definitions.map((tool) => tool.name)).not.toContain("set_project_instructions");
      expect(tools.disclosurePrompt).toContain("read_project_instructions v1");
      expect(tools.disclosurePrompt).not.toContain("set_project_instructions");

      const hiddenCall = await executeTool(tools, "set_project_instructions", {
        content: "不能直接执行",
      });
      expect(hiddenCall).toMatchObject({
        ok: false,
        tool: { name: "set_project_instructions", version: 0 },
        error: { code: "TOOL_NOT_FOUND" },
      });

      const listed = await executeTool(tools, "list_tools", { page: 1, pageSize: 20 });
      expect(listed).toMatchObject({
        ok: true,
        data: {
          page: 1,
          pageSize: 20,
          totalPages: 1,
          tools: expect.arrayContaining([
            expect.objectContaining({ name: "list_project_documents", version: 1 }),
            expect.objectContaining({ name: "read_project_instructions", version: 1 }),
            expect.objectContaining({ name: "set_project_instructions", version: 1 }),
            expect.objectContaining({ name: "list_tools", version: 1 }),
            expect.objectContaining({ name: "get_tool", version: 1 }),
          ]),
        },
      });

      const loaded = await executeTool(tools, "get_tool", {
        name: "set_project_instructions",
      });
      expect(loaded).toMatchObject({
        ok: true,
        data: {
          tool: {
            name: "set_project_instructions",
            version: 1,
            approval: "ask",
            inputSchema: expect.any(Object),
            outputSchema: expect.any(Object),
          },
          callableNextRound: true,
        },
      });
      expect(tools.definitions.map((tool) => tool.name)).toContain("set_project_instructions");

      const listedAfterLoad = await executeTool(tools, "list_tools", {
        page: 1,
        pageSize: 20,
      });
      expect(listedAfterLoad).toMatchObject({
        ok: true,
        data: {
          tools: expect.arrayContaining([
            expect.objectContaining({ name: "set_project_instructions", version: 1 }),
          ]),
        },
      });

      const set = await executeTool(tools, "set_project_instructions", {
        content: "保持第三人称限知",
      });
      expect(set).toMatchObject({
        ok: true,
        tool: { name: "set_project_instructions", version: 1 },
        data: { totalCharacters: 8, updatedAt: expect.any(String) },
      });
      expect(repository.getCurrent()?.content).toBe("保持第三人称限知");
      expect(JSON.stringify(set)).not.toContain("revision");
      expect(JSON.stringify(set)).not.toContain("contentHash");
    } finally {
      await database.close();
    }
  });

  it("searches closed history first and reads one immutable message by messageId", async () => {
    const project = await createProject();
    const database = await ProjectDatabase.open(project.root);
    const conversations = new ConversationRepository(database);
    const sessions = new SessionRepository(database);
    const conversation = await conversations.createConversation({
      projectId: project.manifest.id,
      providerId: "fake",
      model: "fake-model",
    });
    const session = await sessions.createInitialSession({
      conversationId: conversation.id,
      systemPrompt: "system",
    });
    const stored = await conversations.addMessage(
      conversation.id,
      { role: "assistant", content: "主角是一名退休刑警。", reasoningContent: "不能被检索" },
      session.id,
    );
    const firstRuntime = new ProjectToolRuntime(project.root, {
      history: { repository: sessions, conversationId: conversation.id },
    });
    const getToolCall = {
      id: "load-history-search",
      name: "get_tool",
      argumentsJson: JSON.stringify({ name: "search_conversation_history" }),
    };
    const loadedSearchTool = await executeTool(firstRuntime, getToolCall.name, {
      name: "search_conversation_history",
    });
    await conversations.addMessage(
      conversation.id,
      { role: "assistant", content: "", toolCalls: [getToolCall] },
      session.id,
    );
    await conversations.addMessage(
      conversation.id,
      {
        role: "tool",
        name: "get_tool",
        toolCallId: getToolCall.id,
        content: JSON.stringify(loadedSearchTool),
      },
      session.id,
    );
    await database.write((sqlite) =>
      sqlite
        .prepare("UPDATE conversation_sessions SET status = 'closed', closed_at = ? WHERE id = ?")
        .run(new Date().toISOString(), session.id),
    );
    const tools = new ProjectToolRuntime(project.root, {
      history: { repository: sessions, conversationId: conversation.id },
      toolStateMessages: conversations.getToolMessages(conversation.id, "get_tool"),
    });

    try {
      const searched = await executeTool(tools, "search_conversation_history", {
        query: "退休刑警",
      });
      expect(searched).toMatchObject({
        ok: true,
        data: {
          results: [
            {
              messageId: stored.id,
              role: "assistant",
              createdAt: expect.any(String),
              excerpt: expect.stringContaining("退休刑警"),
            },
          ],
        },
      });
      expect(JSON.stringify(searched)).not.toContain("sessionId");
      expect(JSON.stringify(searched)).not.toContain("rank");
      expect(JSON.stringify(searched)).not.toContain("不能被检索");

      await executeTool(tools, "get_tool", { name: "read_conversation_message" });
      const read = await executeTool(tools, "read_conversation_message", {
        messageId: stored.id,
        maxCharacters: 6,
      });
      expect(read).toMatchObject({
        ok: true,
        data: {
          message: {
            messageId: stored.id,
            role: "assistant",
            content: "主角是一名退",
            offset: 0,
            truncated: true,
            nextOffset: 6,
          },
        },
      });
      expect(JSON.stringify(read)).not.toContain("reasoning");
    } finally {
      await database.close();
    }
  });

  it("rejects paths outside the project manuscript directory", async () => {
    const project = await createProject();
    const tools = new ProjectToolRuntime(project.root, {
      approve: async () => "allow_once",
    });
    const result = await executeTool(tools, "write_project_document", {
      path: "../escape.md",
      content: "unsafe",
    });

    expect(result).toMatchObject({
      ok: false,
      tool: { name: "write_project_document", version: 1 },
      error: { code: "PATH_OUTSIDE_PROJECT" },
    });
    expect(await new DocumentService(project.root).list()).toHaveLength(0);
  });
});

async function executeTool(
  runtime: ProjectToolRuntime,
  name: string,
  input: unknown,
): Promise<Record<string, unknown>> {
  return JSON.parse(
    await runtime.execute({
      id: "test-call",
      name,
      argumentsJson: JSON.stringify(input),
    }),
  ) as Record<string, unknown>;
}

async function createProject() {
  const directory = await mkdtemp(path.join(tmpdir(), "cleodoc-tools-test-"));
  temporaryDirectories.push(directory);
  return await new ProjectService().create(path.join(directory, "novel.cleo"));
}
