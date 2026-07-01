-- =====================================================================
-- Migration: 0191_payment_method_client.sql
--
-- Make saved payment methods client-resolvable so staff can save a card /
-- bank on a client's behalf (no portal identity required). Portal-saved
-- methods keep their portal_identity_id; staff-saved methods carry
-- (firm_id, client_id) with a null portal_identity_id.
-- =====================================================================

ALTER TABLE vibetb.payment_method
  ADD COLUMN IF NOT EXISTS firm_id uuid REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS client_id uuid REFERENCES vibetb.client(id) ON DELETE CASCADE,
  ALTER COLUMN portal_identity_id DROP NOT NULL;

CREATE INDEX IF NOT EXISTS payment_method_firm_client_idx
  ON vibetb.payment_method (firm_id, client_id, status);
