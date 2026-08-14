import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { ModelCallRecord, ModelCallStatus, ModelUsage } from "../../contracts/src/index.js";
import type { ProjectDatabase } from "./project-database.js";

interface ModelCallRow {
  id: string;
  provider_id: string;
  model: string;
  request_options_json: string;
  status: ModelCallStatus;
  finish_reason: string | null;
  error_code: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  reasoning_tokens: number | null;
  total_tokens: number | null;
  created_at: string;
  completed_at: string | null;
}

export type CompactionModelCallPhase = "primary" | "segment" | "reduce";

export class ModelCallRepository {
  constructor(private readonly projectDatabase: ProjectDatabase) {}

  async beginCall(input: {
    providerId: string;
    model: string;
    requestOptions: Readonly<Record<string, unknown>>;
  }): Promise<ModelCallRecord> {
    const call = createRunningCall(input);
    await this.projectDatabase.write((database) => insertModelCall(database, call));
    return call;
  }

  async beginCompactionCall(input: {
    compactionJobId: string;
    providerId: string;
    model: string;
    requestOptions: Readonly<Record<string, unknown>>;
    phase: CompactionModelCallPhase;
    segmentIndex?: number;
  }): Promise<ModelCallRecord> {
    const call = createRunningCall(input);
    await this.projectDatabase.transaction((database) => {
      const row = database
        .prepare(
          `SELECT COALESCE(MAX(ordinal), 0) + 1 AS next_ordinal
           FROM compaction_job_model_call_mapping WHERE compaction_job_id = ?`,
        )
        .get(input.compactionJobId) as { next_ordinal: number };
      insertModelCall(database, call);
      database
        .prepare(
          `INSERT INTO compaction_job_model_call_mapping
           (compaction_job_id, model_call_id, ordinal, phase, segment_index)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          input.compactionJobId,
          call.id,
          Number(row.next_ordinal),
          input.phase,
          input.segmentIndex ?? null,
        );
    });
    return call;
  }

  async finish(input: {
    modelCallId: string;
    status: Exclude<ModelCallStatus, "running">;
    finishReason?: string | null;
    errorCode?: string;
    usage?: ModelUsage;
  }): Promise<void> {
    const completedAt = new Date().toISOString();
    await this.projectDatabase.write((database) => {
      database
        .prepare(
          `UPDATE model_calls SET status = ?, finish_reason = ?, error_code = ?,
           prompt_tokens = ?, completion_tokens = ?, reasoning_tokens = ?, total_tokens = ?,
           completed_at = ? WHERE id = ? AND status = 'running'`,
        )
        .run(
          input.status,
          input.finishReason ?? null,
          input.errorCode ?? null,
          input.usage?.inputTokens ?? null,
          input.usage?.outputTokens ?? null,
          input.usage?.reasoningTokens ?? null,
          input.usage?.totalTokens ?? null,
          completedAt,
          input.modelCallId,
        );
    });
  }

  get(id: string): ModelCallRecord | null {
    const row = this.projectDatabase.read(
      (database) =>
        database.prepare("SELECT * FROM model_calls WHERE id = ?").get(id) as
          ModelCallRow | undefined,
    );
    return row === undefined ? null : mapModelCall(row);
  }

  async recoverInterruptedCalls(): Promise<void> {
    const completedAt = new Date().toISOString();
    await this.projectDatabase.write((database) => {
      database
        .prepare(
          `UPDATE model_calls SET status = 'failed', error_code = 'MODEL_CALL_INTERRUPTED',
           completed_at = ? WHERE status = 'running'`,
        )
        .run(completedAt);
    });
  }
}

function createRunningCall(input: {
  providerId: string;
  model: string;
  requestOptions: Readonly<Record<string, unknown>>;
}): ModelCallRecord {
  return {
    id: randomUUID(),
    providerId: input.providerId,
    model: input.model,
    requestOptions: input.requestOptions,
    status: "running",
    finishReason: null,
    errorCode: null,
    usage: null,
    createdAt: new Date().toISOString(),
    completedAt: null,
  };
}

function insertModelCall(database: DatabaseSync, call: ModelCallRecord): void {
  database
    .prepare(
      `INSERT INTO model_calls
       (id, provider_id, model, request_options_json, status, created_at)
       VALUES (?, ?, ?, ?, 'running', ?)`,
    )
    .run(call.id, call.providerId, call.model, JSON.stringify(call.requestOptions), call.createdAt);
}

function mapModelCall(row: ModelCallRow): ModelCallRecord {
  const usage: ModelUsage = {
    ...(row.prompt_tokens === null ? {} : { inputTokens: Number(row.prompt_tokens) }),
    ...(row.completion_tokens === null ? {} : { outputTokens: Number(row.completion_tokens) }),
    ...(row.reasoning_tokens === null ? {} : { reasoningTokens: Number(row.reasoning_tokens) }),
    ...(row.total_tokens === null ? {} : { totalTokens: Number(row.total_tokens) }),
  };
  return {
    id: row.id,
    providerId: row.provider_id,
    model: row.model,
    requestOptions: JSON.parse(row.request_options_json) as Record<string, unknown>,
    status: row.status,
    finishReason: row.finish_reason,
    errorCode: row.error_code,
    usage: Object.keys(usage).length === 0 ? null : usage,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}
