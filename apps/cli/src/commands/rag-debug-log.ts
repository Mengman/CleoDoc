import { mkdir, open, type FileHandle } from "node:fs/promises";
import path from "node:path";

import { AppError } from "../../../../packages/contracts/src/index.js";

export type RagDebugEvent =
  | {
      readonly operation: "index-embed";
      readonly status: "completed" | "failed";
      readonly modelId: string | null;
      readonly language: "zh" | "en" | null;
      readonly durationMs: number;
      readonly dimensions: number | null;
      readonly tokenCount: number;
      readonly processedChunks: number;
      readonly skippedChunks: number;
      readonly writtenChunks: number;
      readonly discardedChunks: number;
      readonly failedChunks: number;
      readonly errorCode: string | null;
    }
  | {
      readonly operation: "semantic-search";
      readonly status: "completed" | "failed";
      readonly modelId: string | null;
      readonly language: "zh" | "en" | null;
      readonly durationMs: number;
      readonly embeddingDurationMs: number | null;
      readonly searchDurationMs: number | null;
      readonly dimensions: number | null;
      readonly tokenCount: number | null;
      readonly resultCount: number | null;
      readonly errorCode: string | null;
    }
  | {
      readonly operation: "hybrid-search";
      readonly status: "completed" | "failed";
      readonly modelId: string | null;
      readonly language: "zh" | "en" | null;
      readonly durationMs: number;
      readonly embeddingDurationMs: number | null;
      readonly exactCandidateCount: number | null;
      readonly ftsCandidateCount: number | null;
      readonly vectorCandidateCount: number | null;
      readonly resultCount: number | null;
      readonly vectorErrorCode: string | null;
      readonly errorCode: string | null;
    };

export class RagDebugFileLogger {
  private constructor(
    readonly filePath: string,
    private readonly file: FileHandle,
  ) {}

  static async create(projectRoot: string): Promise<RagDebugFileLogger> {
    const directory = path.join(projectRoot, ".cleo", "logs");
    await mkdir(directory, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filePath = path.join(directory, `cleodoc-rag-debug-${timestamp}-${process.pid}.log`);
    const file = await open(filePath, "wx", 0o600);
    await file.writeFile(
      `CleoDoc RAG debug log\nstartedAt=${new Date().toISOString()}\n` +
        "This log excludes query text, material text, and vector values.\n\n",
      "utf8",
    );
    return new RagDebugFileLogger(filePath, file);
  }

  async write(event: RagDebugEvent): Promise<void> {
    try {
      await this.file.appendFile(`${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
    } catch (error) {
      throw new AppError("IO_ERROR", "RAG Debug 日志写入失败。", {
        cause: error,
        details: { filePath: this.filePath },
      });
    }
  }

  async close(): Promise<void> {
    await this.file.close();
  }
}
