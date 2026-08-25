-- =====================================================================
-- Migration: 0228_print_multi_gateway.sql  (PGW-1, D-PGW-01..04)
--
-- Multi-location printing: one Vibe Print gateway per office. Gateway
-- identity moves from the firm-keyed encrypted blob on firm_settings to
-- print_gateway rows (nullable office_id; exactly one is_default per
-- firm). The legacy blob keeps working as the implicit firm-default
-- gateway while the table is empty (app-layer fallback, D-PGW-02); the
-- first save in the new Admin UI migrates it.
--
-- printer_assignment gains its owning gateway + a deterministic
-- per-office default flag (D-PGW-08). Bare integer printer references
-- elsewhere gain a paired nullable gateway column (null = firm default,
-- D-PGW-04). print_log.gateway_id has no FK on purpose — the audit row
-- must survive gateway deletion (D-PGW-06).
-- =====================================================================

CREATE TABLE IF NOT EXISTS vibetb.print_gateway (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  office_id uuid REFERENCES vibetb.office(id) ON DELETE SET NULL,
  name text NOT NULL,
  base_url text NOT NULL,
  api_key_encrypted text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  is_default boolean NOT NULL DEFAULT false,
  default_printer_id integer,
  auto_print_signature_confirmation boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS print_gateway_firm_default_uk
  ON vibetb.print_gateway (firm_id) WHERE is_default;
CREATE INDEX IF NOT EXISTS print_gateway_firm_office_idx
  ON vibetb.print_gateway (firm_id, office_id);

ALTER TABLE vibetb.printer_assignment
  ADD COLUMN IF NOT EXISTS gateway_id uuid REFERENCES vibetb.print_gateway(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS is_office_default boolean NOT NULL DEFAULT false;

-- Printer ids are only unique within one gateway. The legacy
-- (firm_id, gateway_printer_id) unique index stays until the PGW-5
-- cutover migration drops it (only one implicit gateway exists until
-- the admin migrates the blob, so it still holds).
CREATE UNIQUE INDEX IF NOT EXISTS printer_assignment_gateway_printer_uk
  ON vibetb.printer_assignment (gateway_id, gateway_printer_id)
  WHERE gateway_id IS NOT NULL;

ALTER TABLE vibetb.print_log
  ADD COLUMN IF NOT EXISTS gateway_id uuid;

ALTER TABLE vibetb.app_user
  ADD COLUMN IF NOT EXISTS default_printer_gateway_id uuid
    REFERENCES vibetb.print_gateway(id) ON DELETE SET NULL;

ALTER TABLE vibetb.signature_print_rule
  ADD COLUMN IF NOT EXISTS gateway_id uuid
    REFERENCES vibetb.print_gateway(id) ON DELETE SET NULL;

ALTER TABLE vibetb.notification_template
  ADD COLUMN IF NOT EXISTS printer_gateway_id uuid
    REFERENCES vibetb.print_gateway(id) ON DELETE SET NULL;

ALTER TABLE vibetb.terminal_readers
  ADD COLUMN IF NOT EXISTS printer_gateway_id uuid
    REFERENCES vibetb.print_gateway(id) ON DELETE SET NULL;
