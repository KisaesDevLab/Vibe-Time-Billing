-- =====================================================================
-- Migration: 0185_print_gateway.sql
--
-- Direct printing via the Vibe Print LAN gateway. Adds the firm's
-- encrypted gateway config (base URL + bearer key + default printer +
-- auto-print toggle), a per-user remembered printer for interactive
-- prints, and an audit log of jobs sent to the gateway.
-- =====================================================================

ALTER TABLE vibetb.firm_settings
  ADD COLUMN IF NOT EXISTS print_gateway_config_encrypted text,
  ADD COLUMN IF NOT EXISTS print_gateway_config_updated_at timestamptz;

ALTER TABLE vibetb.app_user
  ADD COLUMN IF NOT EXISTS default_printer_id integer;

CREATE TABLE IF NOT EXISTS vibetb.print_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  app_user_id uuid REFERENCES vibetb.app_user(id) ON DELETE SET NULL,
  printable_type text NOT NULL,
  printable_id text,
  printer_id integer NOT NULL,
  copies integer NOT NULL DEFAULT 1,
  status text NOT NULL,
  gateway_job_id text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS print_log_firm_created_idx
  ON vibetb.print_log (firm_id, created_at);
