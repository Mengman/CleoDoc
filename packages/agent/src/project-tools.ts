import { z } from "zod";

import type { ModelToolCall, ModelToolDefinition } from "../../contracts/src/index.js";
import { AppError, asAppError } from "../../contracts/src/index.js";
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
}

export class ProjectToolRuntime {
  readonly definitions: readonly ModelToolDefinition[] = [
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
        default:
          return toolError("UNKNOWN_TOOL", `未知工具：${call.name}`);
      }
    } catch (error) {
      const appError = asAppError(error);
      return toolError(appError.code, appError.message);
    }
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
