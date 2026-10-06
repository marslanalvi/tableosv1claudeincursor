-- Workstream F: per-user undo/redo stack bookkeeping on the change log.
-- undone_by_seq: seq of the undo change that reverted this change (NULL = in effect).
-- undo_skipped: change cannot be undone (unsupported op kinds); skipped by the stack.
ALTER TABLE data.base_changes
  ADD COLUMN IF NOT EXISTS undone_by_seq bigint,
  ADD COLUMN IF NOT EXISTS undo_skipped boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS base_changes_actor_idx
  ON data.base_changes (base_id, actor_id, seq DESC);
