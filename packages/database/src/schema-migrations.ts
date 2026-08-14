import { KNOWLEDGE_INDEX_SCHEMA_SQL } from "./current-schema.js";

export const SCHEMA_V8_TO_V9_SQL = `
  ALTER TABLE sources ADD COLUMN parser_version TEXT;
  ALTER TABLE sources ADD COLUMN chunker_version TEXT;
  ALTER TABLE sources ADD COLUMN chunking_config_json TEXT;
  ALTER TABLE sources ADD COLUMN languages_json TEXT NOT NULL DEFAULT '["zh"]';
  ALTER TABLE sources ADD COLUMN index_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (index_status IN ('pending', 'ready', 'stale', 'failed'));
  ALTER TABLE sources ADD COLUMN index_error_code TEXT;
  ALTER TABLE sources ADD COLUMN indexed_at TEXT;
  ALTER TABLE sources DROP COLUMN source_label;
  ALTER TABLE sources DROP COLUMN tags_json;

  ${KNOWLEDGE_INDEX_SCHEMA_SQL}
`;

export const SCHEMA_V9_TO_V10_SQL = `
  CREATE UNIQUE INDEX sources_title_unique
    ON sources(title);
`;

export const SCHEMA_V10_TO_V11_SQL = `
  CREATE TABLE conversations_v11 (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    title TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  INSERT INTO conversations_v11 (id, project_id, title, created_at, updated_at)
    SELECT id, project_id, title, created_at, updated_at FROM conversations;

  CREATE TABLE generations_v11 (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'cancelled', 'failed')),
    content TEXT NOT NULL DEFAULT '',
    usage_json TEXT,
    error_code TEXT,
    saved_document_path TEXT,
    saved_content_hash TEXT,
    created_at TEXT NOT NULL,
    completed_at TEXT
  );
  INSERT INTO generations_v11
    (id, conversation_id, status, content, usage_json, error_code, saved_document_path,
     saved_content_hash, created_at, completed_at)
    SELECT id, conversation_id, status, content, usage_json, error_code, saved_document_path,
           saved_content_hash, created_at, completed_at
    FROM generations;

  CREATE TABLE compaction_jobs_v11 (
    id TEXT PRIMARY KEY,
    source_session_id TEXT NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'validating', 'completed', 'failed', 'cancelled')),
    trigger TEXT NOT NULL,
    prompt_version TEXT NOT NULL,
    first_message_id TEXT NOT NULL,
    last_message_id TEXT NOT NULL,
    orchestration_config_json TEXT NOT NULL,
    summary TEXT,
    error_code TEXT,
    created_at TEXT NOT NULL,
    completed_at TEXT,
    CHECK (
      (status = 'completed' AND summary IS NOT NULL) OR
      (status <> 'completed' AND summary IS NULL)
    )
  );
  INSERT INTO compaction_jobs_v11
    (id, source_session_id, status, trigger, prompt_version, first_message_id,
     last_message_id, orchestration_config_json, summary, error_code, created_at, completed_at)
    SELECT jobs.id, jobs.source_session_id, jobs.status, jobs.trigger, jobs.prompt_version,
           jobs.first_message_id, jobs.last_message_id, jobs.orchestration_config_json,
           summaries.summary, jobs.error_code, jobs.created_at, jobs.completed_at
    FROM compaction_jobs jobs
    LEFT JOIN session_summaries summaries ON summaries.id = jobs.summary_id;

  CREATE TABLE conversation_sessions_v11 (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL CHECK (ordinal > 0),
    status TEXT NOT NULL CHECK (status IN ('active', 'compacting', 'closed')),
    trigger TEXT NOT NULL CHECK (trigger IN ('conversation_started', 'automatic', 'manual')),
    system_prompt_snapshot TEXT NOT NULL,
    inherited_compaction_job_id TEXT REFERENCES compaction_jobs(id) ON DELETE SET NULL,
    estimated_input_tokens INTEGER NOT NULL DEFAULT 0,
    actual_input_tokens INTEGER,
    compaction_required INTEGER NOT NULL DEFAULT 0 CHECK (compaction_required IN (0, 1)),
    started_at TEXT NOT NULL,
    closed_at TEXT,
    UNIQUE (conversation_id, ordinal)
  );
  INSERT INTO conversation_sessions_v11
    (id, conversation_id, ordinal, status, trigger, system_prompt_snapshot,
     inherited_compaction_job_id, estimated_input_tokens, actual_input_tokens,
     compaction_required, started_at, closed_at)
    SELECT sessions.id, sessions.conversation_id, sessions.ordinal, sessions.status,
           sessions.trigger, sessions.system_prompt_snapshot, jobs.id,
           sessions.estimated_input_tokens, sessions.actual_input_tokens,
           sessions.compaction_required, sessions.started_at, sessions.closed_at
    FROM conversation_sessions sessions
    LEFT JOIN compaction_jobs jobs ON jobs.summary_id = sessions.inherited_summary_id;

  DROP TABLE session_summaries;
  DROP TABLE generations;
  DROP TABLE conversation_sessions;
  DROP TABLE compaction_jobs;
  DROP TABLE conversations;

  ALTER TABLE conversations_v11 RENAME TO conversations;
  ALTER TABLE generations_v11 RENAME TO generations;
  ALTER TABLE compaction_jobs_v11 RENAME TO compaction_jobs;
  ALTER TABLE conversation_sessions_v11 RENAME TO conversation_sessions;

  CREATE INDEX generations_conversation_created
    ON generations(conversation_id, created_at DESC);
  CREATE INDEX generations_status_created
    ON generations(status, created_at DESC);
  CREATE UNIQUE INDEX conversation_sessions_one_active
    ON conversation_sessions(conversation_id)
    WHERE status IN ('active', 'compacting');
  CREATE UNIQUE INDEX compaction_jobs_one_active_per_session
    ON compaction_jobs(source_session_id)
    WHERE status IN ('pending', 'running', 'validating');
  CREATE UNIQUE INDEX compaction_jobs_one_completed_per_session
    ON compaction_jobs(source_session_id)
    WHERE status = 'completed';
`;
