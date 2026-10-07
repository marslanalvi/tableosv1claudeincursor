-- Per-user hidden tables (Airtable "Hide table"): hidden tables are not shown
-- as tabs for that user but stay listed in the table switcher.

CREATE TABLE IF NOT EXISTS data.user_hidden_tables (
  user_id    uuid NOT NULL REFERENCES core.users(id) ON DELETE CASCADE,
  base_id    uuid NOT NULL REFERENCES data.bases(id) ON DELETE CASCADE,
  table_id   uuid NOT NULL REFERENCES data.tables(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, table_id)
);

CREATE INDEX IF NOT EXISTS user_hidden_tables_user_base_idx
  ON data.user_hidden_tables (user_id, base_id);
