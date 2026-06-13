-- =====================================================================
-- Migration: 0158_payment_imports.sql
--
-- Payments → Import tab: ingest a payroll-charges CSV (client code,
-- charge date, description, amount). One header row per uploaded file;
-- one row per CSV line recording the outcome (invoice+payment created,
-- prepayment credit, or skipped) with FK breadcrumbs for drill-in and
-- duplicate detection on re-upload (same code+date+description+amount).
--
-- NOTE: no `DO $$ ... $$` blocks (the pglite test harness strips them);
-- bare statements only. Migrate runner wraps each file in one txn.
-- =====================================================================

CREATE TABLE IF NOT EXISTS vibetb.payment_import (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  engagement_type_id uuid REFERENCES vibetb.engagement_type(id) ON DELETE SET NULL,
  payment_method_key text NOT NULL,
  file_name text,
  created_by_app_user_id uuid REFERENCES vibetb.app_user(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS payment_import_firm_idx
  ON vibetb.payment_import (firm_id, created_at DESC);

CREATE TABLE IF NOT EXISTS vibetb.payment_import_row (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id uuid NOT NULL REFERENCES vibetb.payment_import(id) ON DELETE CASCADE,
  firm_id uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  -- Raw CSV fields (kept verbatim for audit + dedupe).
  client_code text NOT NULL,
  client_name text,
  charge_date date NOT NULL,
  description text,
  amount_cents bigint NOT NULL,
  -- Resolution breadcrumbs.
  client_id uuid REFERENCES vibetb.client(id) ON DELETE SET NULL,
  engagement_id uuid REFERENCES vibetb.engagement(id) ON DELETE SET NULL,
  invoice_id uuid REFERENCES vibetb.invoice(id) ON DELETE SET NULL,
  payment_receipt_id uuid REFERENCES vibetb.payment_receipt(id) ON DELETE SET NULL,
  credit_memo_id uuid REFERENCES vibetb.credit_memo(id) ON DELETE SET NULL,
  -- INVOICED_PAID | PREPAYMENT | SKIPPED
  outcome text NOT NULL,
  detail text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS payment_import_row_import_idx
  ON vibetb.payment_import_row (import_id);

-- Dedupe probe: has this exact charge line been imported before?
CREATE INDEX IF NOT EXISTS payment_import_row_dedupe_idx
  ON vibetb.payment_import_row (firm_id, client_code, charge_date, amount_cents);
