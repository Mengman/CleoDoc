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
];
