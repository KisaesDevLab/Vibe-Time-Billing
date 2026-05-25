-- =====================================================================
-- Migration: 0067_invoice_retainer_offer_link.sql  (Stage R3)
--
-- Forward link from a retainer-purchase invoice to the offer it was
-- created for. The portal-selection handler (R3) populates this when
-- it issues the AR invoice; the Stripe webhook reads it to find the
-- offer to activate. Cleaner than a generic jsonb metadata column.
--
-- RESTRICT on delete — an offer cannot be deleted while a paid invoice
-- references it.
-- =====================================================================

ALTER TABLE vibetb.invoice
  ADD COLUMN IF NOT EXISTS retainer_offer_id uuid
    REFERENCES vibetb.retainer_offer(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS invoice_retainer_offer_idx
  ON vibetb.invoice (retainer_offer_id)
  WHERE retainer_offer_id IS NOT NULL;
