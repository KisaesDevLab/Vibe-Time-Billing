-- =====================================================================
-- Migration: 0009_saved_reports.sql
--
-- Saved-report definitions (Phase 18 #21). A staff user can persist a
-- named report definition that captures the URL filter state for any
-- report endpoint. The frontend re-hydrates from `params_json`.
-- =====================================================================

CREATE TABLE IF NOT EXISTS saved_report (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id         UUID NOT NULL REFERENCES firm(id) ON DELETE CASCADE,
  owner_id        UUID NOT NULL REFERENCES app_user(id),
  name            TEXT NOT NULL,
  report_kind     TEXT NOT NULL,         -- 'realization' | 'profitability' | 'utilization' | ...
  params_json     JSONB NOT NULL DEFAULT '{}'::jsonb,
  shared_flag     BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS saved_report_firm_idx ON saved_report (firm_id);
CREATE INDEX IF NOT EXISTS saved_report_owner_idx ON saved_report (owner_id);
CREATE UNIQUE INDEX IF NOT EXISTS saved_report_owner_name_uk ON saved_report (owner_id, name);
