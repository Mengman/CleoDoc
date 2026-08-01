export interface Migration {
  version: number;
  sql: string;
}

export const migrations: readonly Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        model TEXT NOT NULL,
        title TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
        content TEXT NOT NULL,
        name TEXT,
        tool_call_id TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (conversation_id, sequence)
      );

      CREATE INDEX messages_conversation_sequence
        ON messages(conversation_id, sequence);

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
    `,
  },
  {
    version: 2,
    sql: `
      ALTER TABLE messages ADD COLUMN tool_calls_json TEXT;
    `,
  },
  {
    version: 3,
    sql: `
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
        relative_path TEXT NOT NULL UNIQUE,
        content_hash TEXT NOT NULL UNIQUE,
        size INTEGER NOT NULL CHECK (size >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX sources_project_updated
        ON sources(project_id, updated_at DESC);
      CREATE INDEX sources_project_content_hash
        ON sources(project_id, content_hash);
    `,
  },
  {
    version: 4,
    sql: `
      CREATE TABLE conversation_sessions (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL CHECK (ordinal > 0),
        status TEXT NOT NULL CHECK (status IN ('active', 'compacting', 'closed')),
        trigger TEXT NOT NULL CHECK (trigger IN ('conversation_started', 'automatic', 'manual')),
        system_prompt_snapshot TEXT NOT NULL,
        project_instructions_path TEXT,
        project_instructions_snapshot TEXT,
        project_instructions_hash TEXT,
        project_instructions_loaded_at TEXT NOT NULL,
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
        content_json TEXT NOT NULL,
        handoff_text TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        model TEXT NOT NULL,
        usage_json TEXT,
        parameters_json TEXT NOT NULL,
        validation_status TEXT NOT NULL CHECK (validation_status IN ('validated')),
        first_message_id TEXT NOT NULL,
        last_message_id TEXT NOT NULL,
        message_count INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );

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
        parameters_json TEXT NOT NULL,
        usage_json TEXT,
        summary_id TEXT,
        error_code TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT
      );

      ALTER TABLE messages ADD COLUMN session_id TEXT REFERENCES conversation_sessions(id) ON DELETE CASCADE;

      INSERT INTO conversation_sessions
        (id, conversation_id, ordinal, status, trigger, system_prompt_snapshot,
         project_instructions_loaded_at, started_at)
      SELECT 'legacy-' || c.id, c.id, 1, 'active', 'conversation_started', '', c.created_at, c.created_at
      FROM conversations c;

      UPDATE messages
      SET session_id = 'legacy-' || conversation_id
      WHERE session_id IS NULL;

      CREATE INDEX messages_session_sequence ON messages(session_id, sequence);

      CREATE VIRTUAL TABLE conversation_message_fts USING fts5(
        message_id UNINDEXED,
        session_id UNINDEXED,
        conversation_id UNINDEXED,
        role UNINDEXED,
        content,
        tokenize='trigram'
      );

      INSERT INTO conversation_message_fts(message_id, session_id, conversation_id, role, content)
      SELECT id, session_id, conversation_id, role, content
      FROM messages
      WHERE role IN ('user', 'assistant');

      CREATE TRIGGER conversation_message_fts_insert AFTER INSERT ON messages
      WHEN new.role IN ('user', 'assistant')
      BEGIN
        INSERT INTO conversation_message_fts(message_id, session_id, conversation_id, role, content)
        VALUES (new.id, new.session_id, new.conversation_id, new.role, new.content);
      END;

      CREATE TRIGGER conversation_message_fts_delete AFTER DELETE ON messages
      WHEN old.role IN ('user', 'assistant')
      BEGIN
        DELETE FROM conversation_message_fts WHERE message_id = old.id;
      END;
    `,
  },
];
