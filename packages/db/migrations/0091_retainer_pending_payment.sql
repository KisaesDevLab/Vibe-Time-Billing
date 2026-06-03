-- =====================================================================
-- Migration: 0091_retainer_pending_payment.sql
--
-- Firm-initiated retainer billing. Until now there were two paths:
--   • portal-offer flow: client picks tier in portal → AR invoice → pay
--   • manual flow: firm records a retainer as already-paid (no invoice)
--
-- Neither covered "I want to bill the client for a retainer directly
-- from staff side and have it activate when they pay." This migration
-- introduces that third path.
--
-- Changes:
--   1. retainer_status enum     — add 'pending_payment'
--   2. invoice.retainer_id      — new nullable FK directly to retainer
--                                 (parallel to invoice.retainer_offer_id
--                                 which only exists for portal-offer
--                                 invoices)
--
-- Behavior:
--   • A retainer in pending_payment does NOT consume time-entry hours
--     (eligibility check treats it like paused / inactive).
--   • When an invoice with retainer_id IS NOT NULL is marked paid, an
--     activation handler flips the retainer pending_payment → active
--     and writes the ACTIVATION ledger row + schedules expiry warnings.
--   • Existing retainer_offer_id activation path is unchanged.
-- =====================================================================

ALTER TYPE retainer_status ADD VALUE IF NOT EXISTS 'pending_payment';

ALTER TABLE vibetb.invoice
  ADD COLUMN IF NOT EXISTS retainer_id uuid
    REFERENCES vibetb.retainer(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS invoice_retainer_idx
  ON vibetb.invoice (retainer_id)
  WHERE retainer_id IS NOT NULL;
