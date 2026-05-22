-- =====================================================================
-- Migration: 0047_files_storage_visibility.sql
--
-- Phase 6 of the file-manager rebuild — per FILE_MANAGER_ADDENDUM.md
-- §3.5 + §3.6 + §4 Phase 6.
--
-- Two tables:
--   firm_folder_visibility_rules — per-firm policy. The sync worker
--     and the app-upload path consult this when picking a default
--     visibility for a newly indexed/created file. Rules are SQL LIKE
--     patterns against `files.subfolder_path`; first match by
--     priority desc wins; no match → 'private'.
--
--   file_visibility_events — append-only history of every visibility
--     change. Used by the portal "First viewed in portal" audit, the
--     staff "show me what's visible" filter, and the compliance
--     export. Hard-deleted only via retention sweeps.
--
-- Six default rules are seeded for every existing firm so the
-- evaluator has something useful to return on day one. The same six
-- rules are seeded for new firms via packages/db/src/seed-helpers.
-- =====================================================================

CREATE TABLE IF NOT EXISTS firm_folder_visibility_rules (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id            UUID NOT NULL REFERENCES firm(id) ON DELETE CASCADE,
  subfolder_pattern  TEXT NOT NULL,
  default_visibility TEXT NOT NULL,
  priority           INTEGER NOT NULL DEFAULT 0,
  enabled            BOOLEAN NOT NULL DEFAULT true,
  notes              TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT firm_folder_visibility_rules_value_chk CHECK (
    default_visibility IN ('private', 'client_visible')
  )
);

-- Hot index for the resolver: enabled rules per firm, highest priority
-- first. Used by both the sync worker and the upload path on every
-- new-file insert.
CREATE INDEX IF NOT EXISTS idx_firm_visibility_rules_lookup
  ON firm_folder_visibility_rules (firm_id, enabled, priority DESC);

CREATE TABLE IF NOT EXISTS file_visibility_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id     UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  firm_id     UUID NOT NULL REFERENCES firm(id),
  old_value   TEXT NOT NULL,
  new_value   TEXT NOT NULL,
  changed_by  UUID REFERENCES app_user(id),
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  reason      TEXT
);

CREATE INDEX IF NOT EXISTS idx_file_visibility_events_file
  ON file_visibility_events (file_id, changed_at DESC);

-- One-time backfill for existing firms. New firms get the same six
-- rules via the seed helper invoked from the firm-creation path. The
-- INSERT is idempotent under the assumption that a fresh DB has no
-- visibility rules yet; if the seed helper has already run for a firm
-- we'd see duplicate priority-100 rows. Acceptable until a unique
-- index lands — the resolver is order-stable and dedup-safe at query
-- time (first match wins regardless of duplicates).
INSERT INTO firm_folder_visibility_rules
  (firm_id, subfolder_pattern, default_visibility, priority, notes)
SELECT id, 'Invoices', 'client_visible', 100, 'Default — invoices are client-facing'
  FROM firm
UNION ALL
SELECT id, 'Engagement Letters', 'client_visible', 100, 'Default — letters are client-facing'
  FROM firm
UNION ALL
SELECT id, 'Client Copy%', 'client_visible', 100, 'Default — anything in a Client Copy subfolder'
  FROM firm
UNION ALL
SELECT id, 'Workpapers', 'private', 100, 'Default — workpapers are internal'
  FROM firm
UNION ALL
SELECT id, 'Internal%', 'private', 100, 'Default — anything in an Internal subfolder'
  FROM firm
UNION ALL
SELECT id, '%', 'private', 0, 'Default catchall — anything else is private'
  FROM firm
;
