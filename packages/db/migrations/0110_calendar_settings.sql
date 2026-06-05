-- =====================================================================
-- Migration: 0110_calendar_settings.sql  (Calendar Integration, CAL-3)
--
-- Firm-level poll-sync tunables. The bulk sync job runs on a fixed
-- heartbeat and only syncs a connection once sync_interval_minutes have
-- elapsed since its last sync (effective interval, gated in-job).
-- =====================================================================

CREATE TABLE IF NOT EXISTS vibetb.calendar_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  sync_interval_minutes integer NOT NULL DEFAULT 15,
  lookback_days integer NOT NULL DEFAULT 7,
  lookahead_days integer NOT NULL DEFAULT 90,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS calendar_settings_firm_uk
  ON vibetb.calendar_settings (firm_id);
