-- Owner-controlled access: approved devices (browsers can't read MAC addresses,
-- so each browser gets a random device key in an httpOnly cookie that the org
-- owner approves) and owner-issued API tokens with read/write/delete scopes.

CREATE TABLE IF NOT EXISTS core.org_devices (
  id             uuid        PRIMARY KEY DEFAULT public.uuidv7(),
  org_id         uuid        NOT NULL REFERENCES core.organizations(id) ON DELETE CASCADE,
  user_id        uuid        NOT NULL REFERENCES core.users(id) ON DELETE CASCADE,
  device_hash    bytea       NOT NULL CHECK (length(device_hash) = 32),
  label          text        NOT NULL DEFAULT '' CHECK (length(label) <= 100),
  user_agent     text,
  first_ip       inet,
  last_ip        inet,
  status         text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','revoked')),
  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  decided_by     uuid        REFERENCES core.users(id) ON DELETE SET NULL,
  decided_at     timestamptz,
  UNIQUE (org_id, user_id, device_hash)
);
CREATE INDEX IF NOT EXISTS org_devices_org_status_idx ON core.org_devices (org_id, status, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS core.api_tokens (
  id             uuid        PRIMARY KEY DEFAULT public.uuidv7(),
  org_id         uuid        NOT NULL REFERENCES core.organizations(id) ON DELETE CASCADE,
  user_id        uuid        NOT NULL REFERENCES core.users(id) ON DELETE CASCADE,
  name           text        NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  token_prefix   text        NOT NULL,
  token_hash     bytea       NOT NULL CHECK (length(token_hash) = 32),
  scopes         text[]      NOT NULL CHECK (cardinality(scopes) > 0 AND scopes <@ ARRAY['read','write','delete']::text[]),
  -- NULL = every base in the org; otherwise only these bases.
  base_ids       uuid[],
  expires_at     timestamptz,
  last_used_at   timestamptz,
  last_used_ip   inet,
  revoked_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS api_tokens_hash_uq ON core.api_tokens (token_hash);
CREATE INDEX IF NOT EXISTS api_tokens_org_idx ON core.api_tokens (org_id, created_at DESC);
