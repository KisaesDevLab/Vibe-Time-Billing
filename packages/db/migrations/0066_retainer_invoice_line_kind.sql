-- =====================================================================
-- Migration: 0066_retainer_invoice_line_kind.sql  (Stage R2/R3)
--
-- Add 'RETAINER' value to the invoice_line_item_kind enum. Required by
-- R3 when the portal-selection handler issues an AR invoice for the
-- chosen tier — that invoice carries a single RETAINER line item the
-- payment webhook keys off (via invoice.metadata.retainerOfferId).
-- =====================================================================

ALTER TYPE invoice_line_item_kind ADD VALUE IF NOT EXISTS 'RETAINER';
