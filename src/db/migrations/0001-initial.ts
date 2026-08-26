export const SCHEMA_VERSION = 1;

export const INITIAL_SCHEMA_SQL = `
CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  source_type TEXT NOT NULL,
  tier INTEGER NOT NULL CHECK (tier BETWEEN 1 AND 4),
  repository TEXT,
  branch TEXT,
  channel TEXT NOT NULL,
  current_revision TEXT,
  last_indexed_at TEXT,
  config_json TEXT NOT NULL DEFAULT '{}'
) STRICT;

CREATE TABLE source_revisions (
  id INTEGER PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  revision TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  status TEXT NOT NULL,
  added_files INTEGER NOT NULL DEFAULT 0,
  modified_files INTEGER NOT NULL DEFAULT 0,
  deleted_files INTEGER NOT NULL DEFAULT 0,
  documents_changed INTEGER NOT NULL DEFAULT 0,
  chunks_changed INTEGER NOT NULL DEFAULT 0,
  error TEXT
) STRICT;

CREATE TABLE documents (
  id INTEGER PRIMARY KEY,
  document_id TEXT NOT NULL UNIQUE,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  kind TEXT NOT NULL,
  category TEXT NOT NULL,
  language TEXT NOT NULL,
  channel TEXT NOT NULL,
  stability TEXT NOT NULL,
  lifecycle TEXT NOT NULL,
  repository TEXT,
  branch TEXT,
  revision TEXT,
  canonical_url TEXT,
  revision_url TEXT,
  source_file_hash TEXT,
  content_hash TEXT NOT NULL,
  source_modified_at TEXT,
  api_package TEXT,
  api_version TEXT,
  minecraft_version TEXT,
  UNIQUE (source_id, path)
) STRICT;

CREATE TABLE chunks (
  id INTEGER PRIMARY KEY,
  chunk_id TEXT NOT NULL UNIQUE,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  chunk_type TEXT NOT NULL,
  title TEXT NOT NULL,
  heading_path TEXT NOT NULL,
  identifier TEXT,
  symbol_kind TEXT,
  language TEXT,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  json_pointer TEXT,
  stability TEXT NOT NULL,
  lifecycle TEXT NOT NULL,
  UNIQUE (document_id, ordinal)
) STRICT;

CREATE TABLE identifiers (
  id INTEGER PRIMARY KEY,
  chunk_id INTEGER NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  identifier TEXT NOT NULL,
  normalized TEXT NOT NULL,
  leaf_name TEXT NOT NULL,
  identifier_kind TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  alias_type TEXT NOT NULL DEFAULT 'exact',
  UNIQUE (chunk_id, normalized, alias_type)
) STRICT;

CREATE TABLE symbol_edges (
  id INTEGER PRIMARY KEY,
  from_identifier TEXT NOT NULL,
  relation TEXT NOT NULL,
  to_identifier TEXT NOT NULL,
  source_chunk_id INTEGER REFERENCES chunks(id) ON DELETE CASCADE,
  UNIQUE (from_identifier, relation, to_identifier, source_chunk_id)
) STRICT;

CREATE TABLE index_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE VIRTUAL TABLE chunks_fts USING fts5(
  identifier_text,
  title,
  heading,
  aliases,
  body,
  path,
  tokenize = 'unicode61 remove_diacritics 2',
  prefix = '2 3 4'
);

CREATE INDEX idx_documents_source_path ON documents(source_id, path);
CREATE INDEX idx_documents_category ON documents(category);
CREATE INDEX idx_documents_stability ON documents(stability, lifecycle, channel);
CREATE INDEX idx_chunks_document_ordinal ON chunks(document_id, ordinal);
CREATE INDEX idx_identifiers_normalized ON identifiers(normalized);
CREATE INDEX idx_identifiers_identifier ON identifiers(identifier);
CREATE INDEX idx_identifiers_leaf ON identifiers(leaf_name);
`;
