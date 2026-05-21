-- =====================================================================
-- Migration: 0016_office_settings.sql
--
-- Per-office overrides for firm-wide settings (Phase 4 #7). Only the
-- settings that are reasonably office-scoped get overrideable here.
-- Resolution is "office override if set, else firm default".
-- =====================================================================

CREATE TABLE IF NOT EXISTS office_settings (
  office_id UUID PRIMARY KEY REFERENCES office(id) ON DELETE CASCADE,

  -- NULL means "inherit from firm_settings"
  adjustment_approval_threshold_cents BIGINT,
  time_entry_rounding_hours NUMERIC(4, 2),
  late_entry_alert_days INTEGER,
  late_entry_lockout_days INTEGER,
  invoice_numbering_prefix TEXT,

  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
