-- Synced tables: a read-only mirror of a table that lives in another base of the
-- same organization. The destination is an ordinary table (so links, lookups and
-- rollups in the destination base work on it); the sync engine keeps its synced
-- fields and records up to date. Extra fields added in the destination stay editable.

CREATE TABLE IF NOT EXISTS data.table_syncs (
  id               uuid PRIMARY KEY DEFAULT public.uuidv7(),
  workspace_id     uuid NOT NULL,
  base_id          uuid NOT NULL,
  table_id         uuid NOT NULL UNIQUE,
  source_base_id   uuid NOT NULL,
  source_table_id  uuid NOT NULL,
  -- The sync reads the source with this person's permissions.
  owner_user_id    uuid NOT NULL,
  -- source field uuid -> destination field uuid
  field_map        jsonb NOT NULL DEFAULT '{}'::jsonb,
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'error')),
  interval_minutes integer NOT NULL DEFAULT 5 CHECK (interval_minutes BETWEEN 1 AND 1440),
  last_synced_at   timestamptz,
  last_error       text,
  last_record_count integer,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (base_id <> source_base_id)
);

CREATE INDEX IF NOT EXISTS table_syncs_source_idx ON data.table_syncs (source_table_id);
CREATE INDEX IF NOT EXISTS table_syncs_base_idx ON data.table_syncs (base_id);

CREATE TABLE IF NOT EXISTS data.table_sync_records (
  sync_id          uuid NOT NULL REFERENCES data.table_syncs (id) ON DELETE CASCADE,
  source_record_id uuid NOT NULL,
  dest_record_id   uuid NOT NULL,
  -- Hash of the last values written, so unchanged rows aren't rewritten.
  content_hash     text NOT NULL DEFAULT '',
  PRIMARY KEY (sync_id, source_record_id)
);

CREATE INDEX IF NOT EXISTS table_sync_records_dest_idx ON data.table_sync_records (dest_record_id);
