-- Every table carries a visible "Record ID" field (type record_id, value rec_…).
-- New tables get it from bootstrapDefaultTable; this backfills existing ones.
-- Appending 'V' to the current max order key yields a valid fractional key
-- that sorts after every existing field.

WITH targets AS (
  SELECT t.id AS table_id, t.workspace_id, t.base_id, t.created_by, t.next_field_slot AS slot,
         COALESCE(
           (SELECT max(f.order_key COLLATE "C") FROM data.fields f
             WHERE f.table_id = t.id AND f.deleted_at IS NULL),
           'a0'
         ) || 'V' AS order_key
  FROM data.tables t
  WHERE t.deleted_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM data.fields f
      WHERE f.table_id = t.id AND f.type = 'record_id' AND f.deleted_at IS NULL
    )
),
inserted AS (
  INSERT INTO data.fields (id, workspace_id, base_id, table_id, slot, name, type, config, order_key, created_by)
  SELECT public.uuidv7(), workspace_id, base_id, table_id, slot,
         CASE WHEN EXISTS (
           SELECT 1 FROM data.fields f
           WHERE f.table_id = targets.table_id AND f.deleted_at IS NULL AND lower(f.name) = 'record id'
         ) THEN 'Record ID (system)' ELSE 'Record ID' END,
         'record_id', '{}'::jsonb, order_key, created_by
  FROM targets
  RETURNING table_id
)
UPDATE data.tables t
SET next_field_slot = t.next_field_slot + 1
FROM inserted i
WHERE t.id = i.table_id;
