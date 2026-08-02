import { z } from "zod";

import { AppError } from "../../../contracts/src/index.js";
import type { DocumentService } from "../../../project/src/index.js";
import {
  compactionEvent,
  emptyInputSchema,
  toolFailure,
  toolSuccess,
  type EmptyInput,
  type Tool,
  type ToolOutcome,
} from "./tool-contract.js";
import { DOCUMENT_ERRORS, WRITE_DOCUMENT_ERRORS } from "./tool-errors.js";

const updatedAtSchema = z.iso.datetime();

const listProjectDocumentsOutputSchema = z
  .object({
    documents: z.array(
      z
        .object({
          path: z.string(),
          size: z.number().int().nonnegative(),
          updatedAt: updatedAtSchema,
        })
        .strict(),
    ),
  })
  .strict();
type ListProjectDocumentsOutput = z.infer<typeof listProjectDocumentsOutputSchema>;

const readProjectDocumentInputSchema = z
  .object({
    document: z.string().trim().min(1),
    offset: z.number().int().nonnegative().default(0),
    maxCharacters: z.number().int().min(1).max(50_000).default(20_000),
  })
  .strict();
type ReadProjectDocumentInput = z.infer<typeof readProjectDocumentInputSchema>;

const readProjectDocumentOutputSchema = z
  .object({
    document: z
      .object({
        path: z.string(),
        updatedAt: updatedAtSchema,
        offset: z.number().int().nonnegative(),
        content: z.string(),
        truncated: z.boolean(),
        nextOffset: z.number().int().nonnegative().nullable(),
        totalCharacters: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();
type ReadProjectDocumentOutput = z.infer<typeof readProjectDocumentOutputSchema>;

const writeProjectDocumentInputSchema = z
  .object({
    path: z.string().trim().min(1),
    content: z.string().max(500_000),
    overwrite: z.boolean().default(false),
  })
  .strict();
type WriteProjectDocumentInput = z.infer<typeof writeProjectDocumentInputSchema>;

const writeProjectDocumentOutputSchema = z
  .object({
    document: z
      .object({
        path: z.string(),
        size: z.number().int().nonnegative(),
        updatedAt: updatedAtSchema,
        created: z.boolean(),
      })
      .strict(),
  })
  .strict();
type WriteProjectDocumentOutput = z.infer<typeof writeProjectDocumentOutputSchema>;

export class ListProjectDocumentsTool implements Tool<EmptyInput, ListProjectDocumentsOutput> {
  readonly name = "list_project_documents";
  readonly version = 1;
  readonly description =
    "列出当前项目 manuscript 目录中的 Markdown 文档。需要了解现有正文、文件路径或选择后续读取目标时使用；本工具不读取正文内容。";
  readonly exposure = "full";
  readonly approval = "auto";
  readonly errors = DOCUMENT_ERRORS;
  readonly inputSchema = emptyInputSchema;
  readonly outputSchema = listProjectDocumentsOutputSchema;

  constructor(private readonly documents: DocumentService) {}

  async execute(): Promise<ToolOutcome<ListProjectDocumentsOutput>> {
    return toolSuccess({
      documents: (await this.documents.list()).map((document) => ({
        path: document.relativePath,
        size: document.size,
        updatedAt: document.updatedAt,
      })),
    });
  }

  getCompactionMessage(
    _input: EmptyInput,
    outcome: ToolOutcome<ListProjectDocumentsOutput>,
  ): string {
    void _input;
    return compactionEvent(this, outcome, {
      ...(outcome.ok ? { documentCount: outcome.data.documents.length } : {}),
    });
  }
}

export class ReadProjectDocumentTool implements Tool<
  ReadProjectDocumentInput,
  ReadProjectDocumentOutput
> {
  readonly name = "read_project_document";
  readonly version = 1;
  readonly description =
    "通过 manuscript 下的相对路径分段读取当前项目的一份 Markdown 文档。只在确实需要引用正文内容时使用，不得访问项目外文件。";
  readonly exposure = "full";
  readonly approval = "auto";
  readonly errors = DOCUMENT_ERRORS;
  readonly inputSchema = readProjectDocumentInputSchema;
  readonly outputSchema = readProjectDocumentOutputSchema;

  constructor(private readonly documents: DocumentService) {}

  async execute(input: ReadProjectDocumentInput): Promise<ToolOutcome<ReadProjectDocumentOutput>> {
    const document = await this.documents.read(input.document);
    const content = document.content.slice(input.offset, input.offset + input.maxCharacters);
    const nextOffset = input.offset + content.length;
    return toolSuccess({
      document: {
        path: document.summary.relativePath,
        updatedAt: document.summary.updatedAt,
        offset: input.offset,
        content,
        truncated: nextOffset < document.content.length,
        nextOffset: nextOffset < document.content.length ? nextOffset : null,
        totalCharacters: document.content.length,
      },
    });
  }

  getCompactionMessage(
    input: ReadProjectDocumentInput,
    outcome: ToolOutcome<ReadProjectDocumentOutput>,
  ): string {
    const document = outcome.ok ? outcome.data.document : undefined;
    return compactionEvent(this, outcome, {
      path: document?.path ?? input.document,
      ...(document === undefined
        ? {}
        : {
            updatedAt: document.updatedAt,
            offset: document.offset,
            nextOffset: document.nextOffset,
            totalCharacters: document.totalCharacters,
            truncated: document.truncated,
          }),
    });
  }
}

export class WriteProjectDocumentTool implements Tool<
  WriteProjectDocumentInput,
  WriteProjectDocumentOutput
> {
  readonly name = "write_project_document";
  readonly version = 1;
  readonly description =
    "根据用户明确的保存要求，在当前项目 manuscript 目录中创建 Markdown 文档。目标已存在时，只有用户明确要求覆盖才设置 overwrite=true；所有写入都需要用户批准。";
  readonly exposure = "full";
  readonly approval = "ask";
  readonly errors = WRITE_DOCUMENT_ERRORS;
  readonly inputSchema = writeProjectDocumentInputSchema;
  readonly outputSchema = writeProjectDocumentOutputSchema;

  constructor(private readonly documents: DocumentService) {}

  async execute(
    input: WriteProjectDocumentInput,
  ): Promise<ToolOutcome<WriteProjectDocumentOutput>> {
    let exists = false;
    try {
      await this.documents.read(input.path);
      exists = true;
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== "DOCUMENT_NOT_FOUND") throw error;
    }
    if (exists && !input.overwrite) {
      return toolFailure(
        "DOCUMENT_ALREADY_EXISTS",
        "目标文档已经存在，当前调用没有明确覆盖意图。",
        "只有用户明确要求覆盖时才设置 overwrite=true。",
      );
    }
    const saved = await this.documents.save(input.path, input.content, exists);
    return toolSuccess({
      document: {
        path: saved.relativePath,
        size: saved.size,
        updatedAt: saved.updatedAt,
        created: saved.created,
      },
    });
  }

  getCompactionMessage(
    input: WriteProjectDocumentInput,
    outcome: ToolOutcome<WriteProjectDocumentOutput>,
  ): string {
    const document = outcome.ok ? outcome.data.document : undefined;
    return compactionEvent(this, outcome, {
      operation:
        document === undefined
          ? "document_write"
          : document.created
            ? "document_created"
            : "document_updated",
      path: document?.path ?? input.path,
      ...(document === undefined ? {} : { updatedAt: document.updatedAt }),
    });
  }
}
