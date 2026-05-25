-- =====================================================================
-- Migration: 0068_retainer_manual_paused.sql  (Stage R7)
--
-- Decouple retainer activation from the offer / purchase-invoice chain
-- so a firm can manually create a retainer without going through the
-- portal flow. Also add a 'paused' status so a firm can self-disable
-- an active retainer (stop consumption) without voiding (which
-- requires hours_consumed = 0 per D24).
--
-- Changes:
--   1. retainer.offer_id            — drop NOT NULL
--   2. retainer.purchase_invoice_id — drop NOT NULL
--   3. retainer_status enum         — add 'paused'
--   4. retainer.paused_at + paused_reason — bookkeeping
--
-- Behavior:
--   • paused retainers do NOT consume time-entry hours (eligibility
--     check returns 'inactive'). Hours route to billable WIP.
--   • paused → active is a one-step resume. paused → expired is
--     handled by the daily sweep when expiry_date < CURRENT_DATE.
-- =====================================================================

ALTER TABLE vibetb.retainer
  ALTER COLUMN offer_id DROP NOT NULL,
  ALTER COLUMN purchase_invoice_id DROP NOT NULL;

ALTER TYPE retainer_status ADD VALUE IF NOT EXISTS 'paused';

ALTER TABLE vibetb.retainer
  ADD COLUMN IF NOT EXISTS paused_at timestamptz,
  ADD COLUMN IF NOT EXISTS paused_reason text;
