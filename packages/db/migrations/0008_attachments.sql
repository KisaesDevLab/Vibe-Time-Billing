-- =====================================================================
-- Migration: 0008_attachments.sql
--
-- Generic attachment metadata (Phase 8 #17, Phase 13 #24). The actual
-- bytes live on disk under /uploads — we only track metadata and the
-- relative storage_path. The "kind" field discriminates owner type:
-- engagement, invoice, client, time_entry, etc.
-- =====================================================================

CREATE TABLE IF NOT EXISTS attachment (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id         UUID NOT NULL REFERENCES firm(id) ON DELETE CASCADE,
  owner_type      TEXT NOT NULL,    -- 'engagement' | 'invoice' | 'client' | 'time_entry'
  owner_id        UUID NOT NULL,
  filename        TEXT NOT NULL,
  mime_type       TEXT NOT NULL,
  size_bytes      BIGINT NOT NULL,
  storage_path    TEXT NOT NULL,
  uploaded_by_id  UUID NOT NULL REFERENCES app_user(id),
  uploaded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS attachment_owner_idx ON attachment (owner_type, owner_id);
CREATE INDEX IF NOT EXISTS attachment_firm_idx ON attachment (firm_id);
