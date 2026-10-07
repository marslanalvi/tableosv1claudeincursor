-- Automations only react to events that happen while they are turned on.
ALTER TABLE data.automations ADD COLUMN IF NOT EXISTS enabled_at timestamptz;
UPDATE data.automations SET enabled_at = COALESCE(updated_at, created_at) WHERE enabled AND enabled_at IS NULL;
