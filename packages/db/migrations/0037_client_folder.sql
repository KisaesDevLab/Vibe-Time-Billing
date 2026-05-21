-- =====================================================================
-- Migration: 0037_client_folder.sql
--
-- v2 Part 1 — folder hierarchy + folder templates for the Canopy-class
-- file manager. Folders are firm-scoped; client_id NULL + is_internal=
-- true means "firm-internal folder" (no client association — shows up
-- in the new /files Internal files tab).
--
-- folder_id is added to client_file in this migration. CHECK constraint
-- updates on client_file (drop NOT NULL on client_id + storage_path,
-- add scope constraints) land in 0038 so this migration stays focused.
-- =====================================================================

CREATE TABLE IF NOT EXISTS client_folder (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id UUID NOT NULL REFERENCES firm(id) ON DELETE CASCADE,
  client_id UUID REFERENCES client(id) ON DELETE CASCADE,
  parent_folder_id UUID REFERENCES client_folder(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  is_internal BOOLEAN NOT NULL DEFAULT false,
  created_by_id UUID REFERENCES app_user(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for the typical "all folders for client" + tree-build queries.
CREATE INDEX IF NOT EXISTS client_folder_client_idx
  ON client_folder (client_id)
  WHERE client_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS client_folder_internal_idx
  ON client_folder (firm_id)
  WHERE is_internal = true;

CREATE INDEX IF NOT EXISTS client_folder_parent_idx
  ON client_folder (parent_folder_id)
  WHERE parent_folder_id IS NOT NULL;

-- Uniqueness: within a given client + parent, folder names are unique
-- (case-insensitive). Two partial unique indexes — one for client-scoped
-- and one for internal-scoped — because Postgres can't do a single
-- unique with NULL-aware comparison cleanly.
CREATE UNIQUE INDEX IF NOT EXISTS client_folder_client_name_uk
  ON client_folder (client_id, parent_folder_id, lower(name))
  WHERE client_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS client_folder_internal_name_uk
  ON client_folder (firm_id, parent_folder_id, lower(name))
  WHERE is_internal = true;

-- ---------------------------------------------------------------------
-- client_folder_template — firm-scoped folder-tree templates that the
-- Add → "Folder template" action spawns under a chosen parent.
-- structure_json is [{name, children: [...]}] (recursive).
-- Three seeded system templates per firm: Tax / Audit / Bookkeeping.
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS client_folder_template (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id UUID NOT NULL REFERENCES firm(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  structure_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_system BOOLEAN NOT NULL DEFAULT false,
  status entity_status NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS client_folder_template_firm_key_uk
  ON client_folder_template (firm_id, key);

-- Seed system templates for every existing firm.
INSERT INTO client_folder_template (firm_id, key, name, structure_json, is_system)
SELECT f.id, t.key, t.name, t.structure::jsonb, true
FROM firm f
CROSS JOIN (VALUES
  ('tax_client', 'Tax client',
   '[{"name":"Correspondence"},{"name":"Income Tax"},{"name":"Permanent"},{"name":"Workpapers & Support"},{"name":"Other"}]'),
  ('audit_client', 'Audit client',
   '[{"name":"Correspondence"},{"name":"Audit Workpapers"},{"name":"Permanent"},{"name":"Other"}]'),
  ('bookkeeping_client', 'Bookkeeping client',
   '[{"name":"Correspondence"},{"name":"Monthly Workpapers"},{"name":"Permanent"},{"name":"Other"}]')
) AS t(key, name, structure)
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------
-- client_file gains a folder_id column. Nullable — null means the file
-- is at the root (or in the inbox once is_inbox is added in 0038).
-- ---------------------------------------------------------------------

ALTER TABLE client_file
  ADD COLUMN IF NOT EXISTS folder_id UUID REFERENCES client_folder(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS client_file_folder_idx
  ON client_file (folder_id)
  WHERE folder_id IS NOT NULL;
