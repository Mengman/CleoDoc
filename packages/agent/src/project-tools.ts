import { z } from "zod";

import type { ModelToolCall, ModelToolDefinition } from "../../contracts/src/index.js";
import { AppError, asAppError } from "../../contracts/src/index.js";
import type { SessionRepository } from "../../database/src/index.js";
import { DocumentService } from "../../project/src/index.js";

const readDocumentInputSchema = z.object({
  document: z.string().trim().min(1),
  offset: z.number().int().nonnegative().default(0),
  maxCharacters: z.number().int().min(1).max(50_000).default(20_000),
});

const writeDocumentInputSchema = z.object({
  path: z.string().trim().min(1),
  content: z.string().max(500_000),
  overwrite: z.boolean().default(false),
});

const searchHistoryInputSchema = z.object({
  query: z.string().trim().min(1).max(1_000),
  sessionIds: z.array(z.string().min(1)).max(20).optional(),
  roles: z
    .array(z.enum(["user", "assistant"]))
    .max(2)
    .optional(),
  limit: z.number().int().min(1).max(10).default(5),
});

const readHistoryInputSchema = z.object({
  sessionId: z.string().min(1),
  afterMessageId: z.string().min(1).optional(),
  limitMessages: z.number().int().min(1).max(20).default(10),
  maxCharacters: z.number().int().min(1).max(20_000).default(10_000),
});

export interface ToolApprovalRequest {
  toolName: "write_project_document";
  path: string;
  contentLength: number;
  contentPreview: string;
  overwrite: boolean;
}

export type ToolApprovalHandler = (request: ToolApprovalRequest) => Promise<boolean>;

export interface ProjectToolRuntimeOptions {
  approve?: ToolApprovalHandler;
  history?: {
    repository: SessionRepository;
    conversationId: string;
  };
}

export class ProjectToolRuntime {
  readonly definitions: readonly ModelToolDefinition[];

  private readonly projectDefinitions: readonly ModelToolDefinition[] = [
    {
      name: "list_project_documents",
      description:
        "列出当前 CleoDoc 项目 manuscript 目录中的 Markdown 正文文档，返回文档 ID、相对路径、大小和内容哈希。",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: "read_project_document",
      description:
        "读取当前项目中的一份 Markdown 正文。可以使用文档 ID 或 manuscript 下的相对路径，并通过 offset/maxCharacters 分段读取。",
      inputSchema: {
        type: "object",
        properties: {
          document: { type: "string", description: "文档 ID 或相对路径" },
          offset: { type: "integer", minimum: 0, default: 0 },
          maxCharacters: { type: "integer", minimum: 1, maximum: 50_000, default: 20_000 },
        },
        required: ["document"],
        additionalProperties: false,
      },
    },
    {
      name: "write_project_document",
      description:
        "在当前项目的 manuscript 目录中创建 Markdown 文档。适合根据用户要求保存总结、大纲或正文。任何写入都需要用户确认；覆盖必须将 overwrite 设为 true 并再次获得确认。",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "manuscript 下的 .md 相对路径，例如 manuscript/summary.md",
          },
          content: { type: "string", description: "要写入的完整 Markdown 内容" },
          overwrite: { type: "boolean", default: false },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
  ];

  private readonly documents: DocumentService;

  constructor(
    projectRoot: string,
    private readonly options: ProjectToolRuntimeOptions = {},
  ) {
    this.documents = new DocumentService(projectRoot);
    this.definitions = [
      ...this.projectDefinitions,
      ...(options.history === undefined
        ? []
        : [
            {
              name: "search_conversation_history",
              description:
                "仅在累计摘要缺少完成当前任务所需的精确细节时，搜索当前对话中已关闭 Session 的用户与主笔消息。不得用于批量加载全部历史。",
              inputSchema: {
                type: "object",
                properties: {
                  query: { type: "string" },
                  sessionIds: { type: "array", items: { type: "string" }, maxItems: 20 },
                  roles: {
                    type: "array",
                    items: { type: "string", enum: ["user", "assistant"] },
                    maxItems: 2,
                  },
                  limit: { type: "integer", minimum: 1, maximum: 10, default: 5 },
                },
                required: ["query"],
                additionalProperties: false,
              },
            },
            {
              name: "read_conversation_history",
              description:
                "分段读取当前对话中一个已关闭 Session 的精确用户/主笔消息；必须先知道 Session ID，并遵守分页上限。",
              inputSchema: {
                type: "object",
                properties: {
                  sessionId: { type: "string" },
                  afterMessageId: { type: "string" },
                  limitMessages: { type: "integer", minimum: 1, maximum: 20, default: 10 },
                  maxCharacters: { type: "integer", minimum: 1, maximum: 20_000, default: 10_000 },
                },
                required: ["sessionId"],
                additionalProperties: false,
              },
            },
          ]),
    ];
  }

  async execute(call: ModelToolCall): Promise<string> {
    try {
      const rawInput = parseArguments(call.argumentsJson);
      switch (call.name) {
        case "list_project_documents":
          return JSON.stringify({
            ok: true,
            documents: (await this.documents.list()).map((document) => ({
              id: document.id,
              path: document.relativePath,
              size: document.size,
              contentHash: document.contentHash,
              updatedAt: document.updatedAt,
            })),
          });
        case "read_project_document":
          return await this.readDocument(rawInput);
        case "write_project_document":
          return await this.writeDocument(rawInput);
        case "search_conversation_history":
          return this.searchHistory(rawInput);
        case "read_conversation_history":
          return this.readHistory(rawInput);
        default:
          return toolError("UNKNOWN_TOOL", `未知工具：${call.name}`);
      }
    } catch (error) {
      const appError = asAppError(error);
      return toolError(appError.code, appError.message);
    }
  }

  private searchHistory(rawInput: unknown): string {
    if (this.options.history === undefined) {
      return toolError("HISTORY_UNAVAILABLE", "当前任务未授权会话历史查询。");
    }
    const input = searchHistoryInputSchema.parse(rawInput);
    const results = this.options.history.repository.searchClosedHistory({
      conversationId: this.options.history.conversationId,
      query: input.query,
      ...(input.sessionIds === undefined ? {} : { sessionIds: input.sessionIds }),
      ...(input.roles === undefined ? {} : { roles: input.roles }),
      limit: input.limit,
    });
    return JSON.stringify({ ok: true, results });
  }

  private readHistory(rawInput: unknown): string {
    if (this.options.history === undefined) {
      return toolError("HISTORY_UNAVAILABLE", "当前任务未授权会话历史查询。");
    }
    const input = readHistoryInputSchema.parse(rawInput);
    const messages = this.options.history.repository.readClosedHistory({
      conversationId: this.options.history.conversationId,
      sessionId: input.sessionId,
      ...(input.afterMessageId === undefined ? {} : { afterMessageId: input.afterMessageId }),
      limitMessages: input.limitMessages,
    });
    let usedCharacters = 0;
    const bounded = [];
    for (const message of messages) {
      const remaining = input.maxCharacters - usedCharacters;
      if (remaining <= 0) break;
      const content = message.content.slice(0, remaining);
      usedCharacters += content.length;
      bounded.push({
        id: message.id,
        sequence: message.sequence,
        role: message.role,
        createdAt: message.createdAt,
        content,
        contentTruncated: content.length < message.content.length,
      });
      if (content.length < message.content.length) break;
    }
    return JSON.stringify({
      ok: true,
      sessionId: input.sessionId,
      messages: bounded,
      nextAfterMessageId:
        bounded.length === 0 || bounded.length < messages.length
          ? null
          : (bounded.at(-1)?.id ?? null),
    });
  }

  private async readDocument(rawInput: unknown): Promise<string> {
    const input = readDocumentInputSchema.parse(rawInput);
    const document = await this.documents.read(input.document);
    const content = document.content.slice(input.offset, input.offset + input.maxCharacters);
    const nextOffset = input.offset + content.length;
    return JSON.stringify({
      ok: true,
      document: {
        id: document.summary.id,
        path: document.summary.relativePath,
        contentHash: document.summary.contentHash,
        offset: input.offset,
        content,
        truncated: nextOffset < document.content.length,
        nextOffset: nextOffset < document.content.length ? nextOffset : null,
        totalCharacters: document.content.length,
      },
    });
  }

  private async writeDocument(rawInput: unknown): Promise<string> {
    const input = writeDocumentInputSchema.parse(rawInput);
    let exists = false;
    try {
      await this.documents.read(input.path);
      exists = true;
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== "DOCUMENT_NOT_FOUND") {
        throw error;
      }
    }

    if (exists && !input.overwrite) {
      return toolError(
        "DOCUMENT_ALREADY_EXISTS",
        "目标文档已经存在。如用户确实要求覆盖，请将 overwrite 设为 true 后重新请求。",
      );
    }
    if (this.options.approve === undefined) {
      return toolError("USER_APPROVAL_REQUIRED", "本地写入需要用户在 CLI 中明确确认。");
    }
    const approved = await this.options.approve({
      toolName: "write_project_document",
      path: input.path,
      contentLength: input.content.length,
      contentPreview: input.content.slice(0, 240),
      overwrite: exists,
    });
    if (!approved) {
      return toolError("USER_REJECTED", "用户拒绝了本地文档写入请求。");
    }

    const saved = await this.documents.save(input.path, input.content, exists);
    return JSON.stringify({
      ok: true,
      document: {
        id: saved.id,
        path: saved.relativePath,
        contentHash: saved.contentHash,
        size: saved.size,
        created: saved.created,
      },
    });
  }
}

function parseArguments(argumentsJson: string): unknown {
  try {
    return JSON.parse(argumentsJson) as unknown;
  } catch (error) {
    throw new AppError("VALIDATION_ERROR", "Tool Call 参数不是有效 JSON。", { cause: error });
  }
}

function toolError(code: string, message: string): string {
  return JSON.stringify({ ok: false, error: { code, message } });
}
