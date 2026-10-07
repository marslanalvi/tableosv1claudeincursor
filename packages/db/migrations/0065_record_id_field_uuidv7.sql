-- 0064 originally used gen_random_uuid() (v4); public ids require UUIDv7.
-- Re-key those Record ID fields (nothing references them yet except view configs
-- that may have hidden them, which use public ids derived from the v4 id and
-- would fail to decode anyway).
UPDATE data.fields
SET id = public.uuidv7()
WHERE type = 'record_id'
  AND substring(id::text, 15, 1) <> '7';
