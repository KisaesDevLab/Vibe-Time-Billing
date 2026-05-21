-- =====================================================================
-- Migration: 0026_client_expansion.sql
--
-- v2 Sprint A — CRM-class client model expansion. Adds the columns
-- Canopy-style client records need that the v1 schema lacked:
--
--   client_type           · INDIVIDUAL vs BUSINESS. Drives which fields
--                           the wizard shows (filing status is INDIVIDUAL-
--                           only). Default BUSINESS for backward compat.
--   client_facing_name    · Separate display name. NULL = same as legal.
--   external_id           · Tax-prep system integration handle. Unique
--                           per firm when set.
--   filing_status         · INDIVIDUAL filing status enum. NULL for
--                           BUSINESS (CHECK enforces).
--   source_id             · Lead source FK. Column added now without the
--                           FK constraint; 0034 adds the FK + client_source
--                           taxonomy table together.
--   pipeline_stage        · Display state (PROSPECT/CLIENT/OTHER), separate
--                           from lifecycle status. Default CLIENT.
--   active                · Soft-deactivate without archive. Default true.
-- =====================================================================

CREATE TYPE client_type AS ENUM ('INDIVIDUAL', 'BUSINESS');

CREATE TYPE filing_status AS ENUM (
  'SINGLE',
  'MFJ',
  'MFS',
  'HOH',
  'QW'
);

CREATE TYPE pipeline_stage AS ENUM ('PROSPECT', 'CLIENT', 'OTHER');

ALTER TABLE client
  ADD COLUMN IF NOT EXISTS client_type client_type NOT NULL DEFAULT 'BUSINESS',
  ADD COLUMN IF NOT EXISTS client_facing_name TEXT,
  ADD COLUMN IF NOT EXISTS external_id TEXT,
  ADD COLUMN IF NOT EXISTS filing_status filing_status,
  ADD COLUMN IF NOT EXISTS source_id UUID,
  ADD COLUMN IF NOT EXISTS pipeline_stage pipeline_stage NOT NULL DEFAULT 'CLIENT',
  ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;

-- INDIVIDUAL clients may carry a filing status; BUSINESS clients must not.
ALTER TABLE client
  ADD CONSTRAINT client_filing_status_chk
    CHECK (
      (client_type = 'INDIVIDUAL')
      OR filing_status IS NULL
    );

-- external_id is firm-scoped unique when set. NULL allowed and not
-- counted by the partial unique index.
CREATE UNIQUE INDEX IF NOT EXISTS client_firm_external_id_uk
  ON client (firm_id, external_id)
  WHERE external_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS client_pipeline_stage_idx
  ON client (firm_id, pipeline_stage);

CREATE INDEX IF NOT EXISTS client_active_idx
  ON client (firm_id, active)
  WHERE active = false;
