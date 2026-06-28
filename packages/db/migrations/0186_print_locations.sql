-- =====================================================================
-- Migration: 0186_print_locations.sql
--
-- Multi-location printing + Stripe Terminal receipt auto-print.
--   - printer_assignment: map a Vibe Print gateway printer (numeric id)
--     to an office + label, so the picker groups printers by location.
--   - terminal_readers: bind each reader to a printer + per-reader
--     auto-print-receipt toggle.
--   - payment_receipt.terminal_reader_id: recorded at collect time so the
--     completion webhook can resolve the reader's printer.
-- =====================================================================

CREATE TABLE IF NOT EXISTS vibetb.printer_assignment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  gateway_printer_id integer NOT NULL,
  office_id uuid REFERENCES vibetb.office(id) ON DELETE SET NULL,
  label text,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS printer_assignment_firm_printer_uk
  ON vibetb.printer_assignment (firm_id, gateway_printer_id);

ALTER TABLE vibetb.terminal_readers
  ADD COLUMN IF NOT EXISTS printer_id integer,
  ADD COLUMN IF NOT EXISTS auto_print_receipt boolean NOT NULL DEFAULT false;

ALTER TABLE vibetb.payment_receipt
  ADD COLUMN IF NOT EXISTS terminal_reader_id uuid
    REFERENCES vibetb.terminal_readers(id) ON DELETE SET NULL;
