export const CURRENT_SCHEMA_VERSION = 10 as const;

export const KNOWLEDGE_INDEX_SCHEMA_SQL = `
  CREATE TABLE knowledge_chunks (
    chunk_rowid INTEGER PRIMARY KEY,
    chunk_id TEXT NOT NULL UNIQUE,
    source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    content TEXT NOT NULL CHECK (length(content) > 0),
    start_offset INTEGER NOT NULL CHECK (start_offset >= 0),
    end_offset INTEGER NOT NULL CHECK (end_offset > start_offset),
    chunker_version TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (source_id, ordinal)
  );

  CREATE INDEX knowledge_chunks_source_rowid
    ON knowledge_chunks(source_id, chunk_rowid);

  CREATE VIRTUAL TABLE knowledge_chunk_fts USING fts5(
    content,
    content='knowledge_chunks',
    content_rowid='chunk_rowid',
    tokenize='trigram'
  );

  CREATE TRIGGER knowledge_chunk_fts_insert AFTER INSERT ON knowledge_chunks
  BEGIN
    INSERT INTO knowledge_chunk_fts(rowid, content)
    VALUES (new.chunk_rowid, new.content);
  END;

  CREATE TRIGGER knowledge_chunk_fts_delete AFTER DELETE ON knowledge_chunks
  BEGIN
    INSERT INTO knowledge_chunk_fts(knowledge_chunk_fts, rowid, content)
    VALUES ('delete', old.chunk_rowid, old.content);
  END;

  CREATE TRIGGER knowledge_chunk_fts_update AFTER UPDATE OF content ON knowledge_chunks
  BEGIN
    INSERT INTO knowledge_chunk_fts(knowledge_chunk_fts, rowid, content)
    VALUES ('delete', old.chunk_rowid, old.content);
    INSERT INTO knowledge_chunk_fts(rowid, content)
    VALUES (new.chunk_rowid, new.content);
  END;
`;

/**
 * Complete schema for a newly-created CleoDoc project database.
 *
 * This is intentionally a baseline, not a replay of historical migrations. Existing
 * databases that already record the current schema version use their schema unchanged.
 */
export const CURRENT_SCHEMA_SQL = `
  CREATE TABLE conversations (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    model TEXT NOT NULL,
    title TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE generations (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    provider_id TEXT NOT NULL,
    model TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'cancelled', 'failed')),
    content TEXT NOT NULL DEFAULT '',
    usage_json TEXT,
    error_code TEXT,
    saved_document_path TEXT,
    saved_content_hash TEXT,
    created_at TEXT NOT NULL,
    completed_at TEXT
  );

  CREATE INDEX generations_conversation_created
    ON generations(conversation_id, created_at DESC);
  CREATE INDEX generations_status_created
    ON generations(status, created_at DESC);

  CREATE TABLE sources (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    source_type TEXT NOT NULL CHECK (source_type IN ('material')),
    origin TEXT NOT NULL CHECK (origin IN ('file', 'paste')),
    format TEXT NOT NULL CHECK (format IN ('text', 'markdown')),
    title TEXT NOT NULL,
    source_label TEXT,
    original_file_name TEXT,
    tags_json TEXT NOT NULL,
    languages_json TEXT NOT NULL DEFAULT '["zh"]',
    relative_path TEXT NOT NULL UNIQUE,
    content_hash TEXT NOT NULL UNIQUE,
    size INTEGER NOT NULL CHECK (size >= 0),
    parser_version TEXT,
    chunker_version TEXT,
    chunking_config_json TEXT,
    index_status TEXT NOT NULL DEFAULT 'pending'
      CHECK (index_status IN ('pending', 'ready', 'stale', 'failed')),
    index_error_code TEXT,
    indexed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX sources_project_updated
    ON sources(project_id, updated_at DESC);
  CREATE INDEX sources_project_content_hash
    ON sources(project_id, content_hash);

  ${KNOWLEDGE_INDEX_SCHEMA_SQL}

  CREATE TABLE conversation_sessions (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL CHECK (ordinal > 0),
    status TEXT NOT NULL CHECK (status IN ('active', 'compacting', 'closed')),
    trigger TEXT NOT NULL CHECK (trigger IN ('conversation_started', 'automatic', 'manual')),
    system_prompt_snapshot TEXT NOT NULL,
    inherited_summary_id TEXT,
    estimated_input_tokens INTEGER NOT NULL DEFAULT 0,
    actual_input_tokens INTEGER,
    compaction_required INTEGER NOT NULL DEFAULT 0 CHECK (compaction_required IN (0, 1)),
    started_at TEXT NOT NULL,
    closed_at TEXT,
    UNIQUE (conversation_id, ordinal)
  );

  CREATE UNIQUE INDEX conversation_sessions_one_active
    ON conversation_sessions(conversation_id)
    WHERE status IN ('active', 'compacting');

  CREATE TABLE session_summaries (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    source_session_id TEXT NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
    summary TEXT NOT NULL,
    first_message_id TEXT NOT NULL,
    last_message_id TEXT NOT NULL,
    message_count INTEGER NOT NULL CHECK (message_count >= 0),
    prompt_version TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    model TEXT NOT NULL,
    usage_json TEXT,
    created_at TEXT NOT NULL
  );

  CREATE INDEX session_summaries_conversation_created
    ON session_summaries(conversation_id, created_at DESC);
  CREATE INDEX session_summaries_source_session
    ON session_summaries(source_session_id);

  CREATE TABLE compaction_jobs (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    source_session_id TEXT NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
    previous_summary_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'validating', 'completed', 'failed', 'cancelled')),
    trigger TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    model TEXT NOT NULL,
    prompt_version TEXT NOT NULL,
    first_message_id TEXT NOT NULL,
    last_message_id TEXT NOT NULL,
    message_count INTEGER NOT NULL,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    orchestration_config_json TEXT NOT NULL,
    usage_json TEXT,
    summary_id TEXT,
    error_code TEXT,
    created_at TEXT NOT NULL,
    completed_at TEXT
  );

  CREATE TABLE model_calls (
    id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL,
    model TEXT NOT NULL,
    request_options_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'cancelled', 'failed')),
    finish_reason TEXT,
    error_code TEXT,
    prompt_tokens INTEGER CHECK (prompt_tokens IS NULL OR prompt_tokens >= 0),
    completion_tokens INTEGER CHECK (completion_tokens IS NULL OR completion_tokens >= 0),
    reasoning_tokens INTEGER CHECK (reasoning_tokens IS NULL OR reasoning_tokens >= 0),
    total_tokens INTEGER CHECK (total_tokens IS NULL OR total_tokens >= 0),
    created_at TEXT NOT NULL,
    completed_at TEXT
  );

  CREATE TABLE generation_model_call_mapping (
    generation_id TEXT NOT NULL REFERENCES generations(id) ON DELETE CASCADE,
    model_call_id TEXT NOT NULL UNIQUE REFERENCES model_calls(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL CHECK (ordinal > 0),
    PRIMARY KEY (generation_id, model_call_id),
    UNIQUE (generation_id, ordinal)
  );

  CREATE TABLE compaction_job_model_call_mapping (
    compaction_job_id TEXT NOT NULL REFERENCES compaction_jobs(id) ON DELETE CASCADE,
    model_call_id TEXT NOT NULL UNIQUE REFERENCES model_calls(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL CHECK (ordinal > 0),
    phase TEXT NOT NULL CHECK (phase IN ('primary', 'segment', 'reduce')),
    segment_index INTEGER CHECK (segment_index IS NULL OR segment_index >= 0),
    PRIMARY KEY (compaction_job_id, model_call_id),
    UNIQUE (compaction_job_id, ordinal)
  );

  CREATE TABLE messages (
    message_rowid INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
    content TEXT NOT NULL,
    reasoning_content TEXT,
    name TEXT,
    tool_call_id TEXT,
    tool_calls_json TEXT,
    created_at TEXT NOT NULL,
    session_id TEXT NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
    model_call_id TEXT UNIQUE REFERENCES model_calls(id),
    UNIQUE (conversation_id, sequence)
  );

  CREATE INDEX messages_session_sequence ON messages(session_id, sequence);
  CREATE INDEX messages_conversation_rowid ON messages(conversation_id, message_rowid);

  CREATE VIEW searchable_conversation_messages AS
  SELECT message_rowid, content
  FROM messages
  WHERE role IN ('user', 'assistant');

  CREATE VIRTUAL TABLE conversation_message_fts USING fts5(
    content,
    content='searchable_conversation_messages',
    content_rowid='message_rowid',
    tokenize='trigram'
  );

  CREATE TRIGGER conversation_message_fts_insert AFTER INSERT ON messages
  WHEN new.role IN ('user', 'assistant')
  BEGIN
    INSERT INTO conversation_message_fts(rowid, content)
    VALUES (new.message_rowid, new.content);
  END;

  CREATE TRIGGER conversation_message_fts_delete AFTER DELETE ON messages
  WHEN old.role IN ('user', 'assistant')
  BEGIN
    INSERT INTO conversation_message_fts(conversation_message_fts, rowid, content)
    VALUES ('delete', old.message_rowid, old.content);
  END;

  CREATE TRIGGER messages_immutable_update BEFORE UPDATE ON messages
  BEGIN
    SELECT RAISE(ABORT, 'messages are immutable');
  END;

  CREATE TABLE project_instruction_revisions (
    revision INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`;
