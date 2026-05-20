-- =====================================================================
-- Migration: 0007_engagement_letters.sql
--
-- Engagement letter storage (Phase 8 #17). Each engagement may have
-- 0..N letter versions. The PDF content lives on disk under /uploads
-- per ops/restore.md; we only track metadata + the rendered HTML for
-- preview.
-- =====================================================================

CREATE TABLE IF NOT EXISTS engagement_letter (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  engagement_id   UUID NOT NULL REFERENCES engagement(id) ON DELETE CASCADE,
  version         INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'DRAFT', -- DRAFT | SENT | ACCEPTED | REJECTED | VOIDED
  body_html       TEXT NOT NULL,
  storage_path    TEXT,                          -- /uploads/letters/<uuid>.pdf
  sent_at         TIMESTAMPTZ,
  sent_to_email   TEXT,
  accepted_at     TIMESTAMPTZ,
  accepted_ip     TEXT,
  voided_at       TIMESTAMPTZ,
  voided_reason   TEXT,
  created_by_id   UUID NOT NULL REFERENCES app_user(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (engagement_id, version)
);
CREATE INDEX IF NOT EXISTS engagement_letter_eng_idx ON engagement_letter (engagement_id);
CREATE INDEX IF NOT EXISTS engagement_letter_status_idx ON engagement_letter (status);

-- Required-field rules (Phase 9 #11). When a time-entry is written and
-- matches conditions (engagement type, work code, etc.), the listed
-- fields are required. Stored as JSON for flexibility; the rule engine
-- lives in @vibe/core.
CREATE TABLE IF NOT EXISTS required_field_rule (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id         UUID NOT NULL REFERENCES firm(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  conditions_json JSONB NOT NULL,
  required_fields JSONB NOT NULL,
  status          TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS required_field_rule_firm_idx ON required_field_rule (firm_id, status);
