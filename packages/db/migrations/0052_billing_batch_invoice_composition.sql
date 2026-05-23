-- =====================================================================
-- Migration: 0052_billing_batch_invoice_composition.sql
--
-- Lets a CPA shape the invoice BEFORE generation, on the billing batch:
--   • invoice_description — free-text memo that lands in the invoice
--     header (replaces the auto-generated default).
--   • invoice_line_items   — jsonb array of {description, amountCents}
--     used to split the bill across multiple lines on the invoice.
--
-- When generate-from-batch fires:
--   • if invoice_line_items is non-empty, it replaces the auto line.
--     Sum is verified to match the billed total.
--   • if invoice_description is set, it lands on invoice.notes.
-- =====================================================================

ALTER TABLE billing_batch
  ADD COLUMN invoice_description text,
  ADD COLUMN invoice_line_items jsonb;
