-- =====================================================================
-- Migration: 0060_files_escrow_zone.sql
--
-- Extends Files v2 with a third visibility state — 'escrow' — that
-- represents "uploaded, gated by an invoice payment". The Stripe
-- webhook (and /payments/receive) flips escrow files to client_visible
-- when the gating invoice clears. Refunds revert the flip.
--
-- This is the standalone-plan substitute for the "vault" concept in
-- the Connect addendum: rather than build a parallel module, we extend
-- the existing files table.
--
-- Changes:
--   1. files.visibility allowed values: 'private' | 'client_visible' |
--      'escrow' (no enum type rewrite — visibility is a text column with
--      app-level validation in apps/api/src/files/visibility.ts).
--   2. files.invoice_id (nullable FK to invoice). Set when uploader
--      tags the file as escrowed for a specific invoice. NULL on
--      non-escrow rows.
--   3. files.promoted_at (nullable timestamp). Set when an escrow file
--      flips to client_visible via payment. Provides an audit trail.
--   4. Partial index for the pay-to-unlock lookup hot path:
--      "give me every escrow file gated by invoice X".
-- =====================================================================

ALTER TABLE vibetb.files
  ADD COLUMN invoice_id uuid REFERENCES vibetb.invoice(id) ON DELETE SET NULL;

ALTER TABLE vibetb.files
  ADD COLUMN promoted_at timestamptz;

-- Partial index: only escrow rows participate in the promote-on-paid
-- lookup. The combination (invoice_id, visibility='escrow') is the
-- exact predicate the webhook uses.
CREATE INDEX files_escrow_invoice_idx
  ON vibetb.files (invoice_id)
  WHERE visibility = 'escrow' AND deleted_at IS NULL;

-- Defensive check: invoice_id is only meaningful for escrow rows. We
-- don't enforce strict NULL elsewhere (it's harmless metadata if set
-- on a private/client_visible file), but visibility='escrow' MUST have
-- a non-null invoice_id — there's no way to know what unlocks it
-- otherwise.
ALTER TABLE vibetb.files
  ADD CONSTRAINT files_escrow_requires_invoice_ck
  CHECK (visibility != 'escrow' OR invoice_id IS NOT NULL);
