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

  ${KNOWLEDGE_INDEX_SCHEMA_SQL}
`;
