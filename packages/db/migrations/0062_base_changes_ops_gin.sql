-- Record revision history (GET .../records/:r/history) finds a record's changes
-- with jsonb containment on ops, e.g. ops @> '[{"recordId": "<uuid>"}]'.
CREATE INDEX IF NOT EXISTS base_changes_ops_gin
  ON data.base_changes USING gin (ops jsonb_path_ops);
