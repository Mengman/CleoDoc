import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("CleoDoc CLI", () => {
  it("creates a project, streams a model response, saves it, and reads it back", async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "cleodoc-cli-test-"));
    temporaryDirectories.push(temporaryDirectory);
    const projectDirectory = path.join(temporaryDirectory, "story.cleo");
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      CLEODOC_HOME: path.join(temporaryDirectory, "cli-state"),
      OPENAI_API_KEY: "test-key",
      CLEODOC_MODEL: "test-model",
    };

    const server = createServer((request, response) => {
      if (request.url === "/v1/chat/completions") {
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.write('data: {"choices":[{"delta":{"content":"# 第一章\\n\\n"}}]}\n\n');
        response.write(
          'data: {"choices":[{"delta":{"content":"钟声在雨里停了。"},"finish_reason":"stop"}]}\n\n',
        );
        response.end("data: [DONE]\n\n");
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("Mock server did not expose a TCP port.");
      }
      environment.OPENAI_BASE_URL = `http://127.0.0.1:${address.port}/v1`;

      const initialized = await runCli(["init", projectDirectory, "--name", "钟声"], environment);
      expect(initialized.exitCode).toBe(0);
      expect(initialized.stdout).toContain("已创建项目：钟声");

      const generated = await runCli(
        ["chat", "--prompt", "写一个开场", "--save", "manuscript/chapter-001.md"],
        environment,
      );
      expect(generated.exitCode).toBe(0);
      expect(generated.stdout).toContain("钟声在雨里停了。");
      expect(generated.stdout).toContain("已创建：manuscript/chapter-001.md");

      const shown = await runCli(["document", "show", "manuscript/chapter-001.md"], environment);
      expect(shown.exitCode).toBe(0);
      expect(shown.stdout).toContain("# 第一章");
      expect(shown.stdout).toContain("钟声在雨里停了。");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    }
  });

  it("keeps interactive chat alive after timeout and exposes the persisted history", async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "cleodoc-cli-timeout-test-"));
    temporaryDirectories.push(temporaryDirectory);
    const projectDirectory = path.join(temporaryDirectory, "story.cleo");
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      CLEODOC_HOME: path.join(temporaryDirectory, "cli-state"),
      OPENAI_API_KEY: "test-key",
      CLEODOC_MODEL: "test-model",
    };
    let chatRequestCount = 0;
    const server = createServer((request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end();
        return;
      }
      chatRequestCount += 1;
      if (chatRequestCount === 1) {
        response.writeHead(504, { "Content-Type": "application/json" });
        response.end('{"error":{"message":"gateway timeout"}}');
        return;
      }
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(
        'data: {"choices":[{"delta":{"content":"稍后重试成功。"},"finish_reason":"stop"}]}\n\n',
      );
      response.end("data: [DONE]\n\n");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("Mock server did not expose a TCP port.");
      }
      environment.OPENAI_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
      expect((await runCli(["init", projectDirectory], environment)).exitCode).toBe(0);

      const chat = await runInteractiveCli(["chat"], environment, [
        "第一次请求",
        "再次尝试",
        "/history",
        "/exit",
      ]);
      expect(chat.exitCode, JSON.stringify(chat)).toBe(0);
      expect(chat.stdout).toContain("API 连接超时，本轮消息已经保存");
      expect(chat.stdout).toContain("稍后重试成功。");
      expect(chat.stdout).toContain("聊天历史：");
      expect(chat.stdout).toContain("聊天记录已保存在当前项目中");

      const listed = await runCli(["conversation", "list"], environment);
      expect(listed.exitCode).toBe(0);
      const conversationId = listed.stdout.match(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
      )?.[0];
      expect(conversationId).toBeDefined();
      const shown = await runCli(["conversation", "show", conversationId!], environment);
      expect(shown.exitCode).toBe(0);
      expect(shown.stdout).toContain("第一次请求");
      expect(shown.stdout).toContain("再次尝试");
      expect(shown.stdout).toContain("稍后重试成功。");

      const resumed = await runInteractiveCli(["chat"], environment, ["/resume 1", "/exit"]);
      expect(resumed.exitCode, JSON.stringify(resumed)).toBe(0);
      expect(resumed.stdout).toContain("最近 5 条聊天记录");
      expect(resumed.stdout).toContain("[1]");
      expect(resumed.stdout).toContain("已恢复对话");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    }
  });

  it("confirms an LLM tool call before writing a summarized document", async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "cleodoc-cli-tool-test-"));
    temporaryDirectories.push(temporaryDirectory);
    const projectDirectory = path.join(temporaryDirectory, "story.cleo");
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      CLEODOC_HOME: path.join(temporaryDirectory, "cli-state"),
      OPENAI_API_KEY: "test-key",
      CLEODOC_MODEL: "test-model",
    };
    let chatRequestCount = 0;
    const server = createServer((request, response) => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end();
        return;
      }
      chatRequestCount += 1;
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      if (chatRequestCount === 1) {
        response.write(
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-save","function":{"name":"write_project_document","arguments":"{\\"path\\":\\"manuscript/summary.md\\",\\"content\\":\\"# 总结\\\\n\\\\n采用雨夜车站作为开场。\\\\n\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
        );
      } else {
        response.write(
          'data: {"choices":[{"delta":{"content":"已经按你的要求保存总结。"},"finish_reason":"stop"}]}\n\n',
        );
      }
      response.end("data: [DONE]\n\n");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("Mock server did not expose a TCP port.");
      }
      environment.OPENAI_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
      expect((await runCli(["init", projectDirectory], environment)).exitCode).toBe(0);

      const chat = await runInteractiveCli(
        ["chat"],
        environment,
        ["总结当前讨论并保存", "/exit"],
        ["y"],
      );
      expect(chat.exitCode, JSON.stringify(chat)).toBe(0);
      expect(chat.stdout).toContain("[工具请求] write_project_document");
      expect(chat.stdout).toContain("LLM 请求创建项目文档：manuscript/summary.md");
      expect(chat.stdout).toContain("已经按你的要求保存总结。");
      expect(chatRequestCount).toBe(2);

      const shown = await runCli(["document", "show", "manuscript/summary.md"], environment);
      expect(shown.exitCode).toBe(0);
      expect(shown.stdout).toContain("# 总结");
      expect(shown.stdout).toContain("采用雨夜车站作为开场。");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    }
  });

  it("manages file and pasted materials through the CLI without duplicating content", async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "cleodoc-cli-material-test-"));
    temporaryDirectories.push(temporaryDirectory);
    const projectDirectory = path.join(temporaryDirectory, "story.cleo");
    const inputFile = path.join(temporaryDirectory, "railway.md");
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      CLEODOC_HOME: path.join(temporaryDirectory, "cli-state"),
    };
    await writeFile(inputFile, "# 铁路资料\n\n末班车在午夜到站。\n", "utf8");
    expect((await runCli(["init", projectDirectory], environment)).exitCode).toBe(0);

    const added = await runCli(
      [
        "material",
        "add",
        inputFile,
        "--title",
        "铁路时刻资料",
        "--source",
        "旧报纸",
        "--tags",
        "历史,铁路",
      ],
      environment,
    );
    expect(added.exitCode, JSON.stringify(added)).toBe(0);
    expect(added.stdout).toContain("已添加资料：铁路时刻资料");
    const materialId = added.stdout.match(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    )?.[0];
    expect(materialId).toBeDefined();

    const duplicate = await runCli(["material", "add", inputFile], environment);
    expect(duplicate.exitCode).toBe(0);
    expect(duplicate.stdout).toContain("资料已存在，未重复导入");

    const pasted = await runCli(
      ["material", "add", "--stdin", "--title", "人物口述", "--format", "text"],
      environment,
      "嫌疑人声称午夜一直在家。\n",
    );
    expect(pasted.exitCode).toBe(0);
    expect(pasted.stdout).toContain("已添加资料：人物口述");

    const shown = await runCli(["material", "show", materialId!], environment);
    expect(shown.exitCode).toBe(0);
    expect(shown.stdout).toContain("来源：旧报纸");
    expect(shown.stdout).toContain("末班车在午夜到站");

    const renamed = await runCli(["material", "rename", materialId!, "铁路历史资料"], environment);
    expect(renamed.exitCode).toBe(0);
    expect(renamed.stdout).toContain("已重命名资料：铁路历史资料");

    const listed = await runCli(["material", "list"], environment);
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout).toContain("铁路历史资料");
    expect(listed.stdout).toContain("人物口述");

    const removed = await runCli(["material", "remove", materialId!], environment);
    expect(removed.exitCode).toBe(0);
    expect(removed.stdout).toContain("已删除资料：铁路历史资料");
    await expect(runCli(["material", "show", materialId!], environment)).resolves.toMatchObject({
      exitCode: 3,
    });
  });
});

async function runCli(
  argumentsList: readonly string[],
  environment: NodeJS.ProcessEnv,
  standardInput?: string,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "apps/cli/src/main.ts", ...argumentsList],
      {
        cwd: repositoryRoot,
        env: environment,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
    child.stdin.end(standardInput);
  });
}

async function runInteractiveCli(
  argumentsList: readonly string[],
  environment: NodeJS.ProcessEnv,
  inputs: readonly string[],
  approvals: readonly string[] = [],
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "apps/cli/src/main.ts", ...argumentsList],
      {
        cwd: repositoryRoot,
        env: environment,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    let sentInputs = 0;
    let sentApprovals = 0;
    let inputEnded = false;
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
      const promptCount = stdout.split("你：").length - 1;
      while (sentInputs < promptCount && sentInputs < inputs.length) {
        child.stdin.write(`${inputs[sentInputs]}\n`);
        sentInputs += 1;
      }
      const approvalPromptCount = stdout.split("允许本次写入？").length - 1;
      while (sentApprovals < approvalPromptCount && sentApprovals < approvals.length) {
        child.stdin.write(`${approvals[sentApprovals]}\n`);
        sentApprovals += 1;
      }
      if (!inputEnded && sentInputs === inputs.length && sentApprovals === approvals.length) {
        inputEnded = true;
        child.stdin.end();
      }
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}
