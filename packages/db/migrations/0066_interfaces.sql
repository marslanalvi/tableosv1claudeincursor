-- Interface builder storage (architecture 13 §2): interfaces, draft pages, immutable published versions.

CREATE TABLE IF NOT EXISTS data.interfaces (
  id                   uuid        PRIMARY KEY DEFAULT public.uuidv7(),
  workspace_id         uuid        NOT NULL,
  base_id              uuid        NOT NULL REFERENCES data.bases(id) ON DELETE CASCADE,
  name                 text        NOT NULL CHECK (length(name) BETWEEN 1 AND 255),
  description          text        NOT NULL DEFAULT '',
  icon                 text        NOT NULL DEFAULT '◧',
  theme                jsonb       NOT NULL DEFAULT '{}'::jsonb,
  navigation           jsonb       NOT NULL DEFAULT '{}'::jsonb,
  draft_revision       integer     NOT NULL DEFAULT 1,
  published_version_id uuid,
  published_revision   integer,
  published_at         timestamptz,
  status               text        NOT NULL DEFAULT 'draft_only'
                         CHECK (status IN ('draft_only', 'published', 'unpublished')),
  order_key            text        NOT NULL COLLATE "C",
  created_by           uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  deleted_at           timestamptz,
  deleted_by           uuid
);

CREATE INDEX IF NOT EXISTS interfaces_base_idx
  ON data.interfaces (base_id, order_key) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS data.interface_pages (
  id            uuid        PRIMARY KEY DEFAULT public.uuidv7(),
  interface_id  uuid        NOT NULL REFERENCES data.interfaces(id) ON DELETE CASCADE,
  workspace_id  uuid        NOT NULL,
  base_id       uuid        NOT NULL,
  name          text        NOT NULL CHECK (length(name) BETWEEN 1 AND 255),
  kind          text        NOT NULL DEFAULT 'dashboard'
                  CHECK (kind IN ('dashboard', 'record_list', 'record_detail', 'form', 'overview', 'blank')),
  layout        jsonb       NOT NULL DEFAULT '{"sections":[],"elements":[]}'::jsonb,
  page_revision integer     NOT NULL DEFAULT 1,
  order_key     text        NOT NULL COLLATE "C",
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);

CREATE INDEX IF NOT EXISTS interface_pages_interface_idx
  ON data.interface_pages (interface_id, order_key) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS data.interface_versions (
  id             uuid        PRIMARY KEY DEFAULT public.uuidv7(),
  interface_id   uuid        NOT NULL REFERENCES data.interfaces(id) ON DELETE CASCADE,
  workspace_id   uuid        NOT NULL,
  base_id        uuid        NOT NULL,
  version_no     integer     NOT NULL,
  snapshot       jsonb       NOT NULL,
  published_by   uuid,
  published_at   timestamptz NOT NULL DEFAULT now(),
  release_note   text        NOT NULL DEFAULT '',
  UNIQUE (interface_id, version_no)
);
