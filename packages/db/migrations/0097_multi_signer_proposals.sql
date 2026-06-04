-- =====================================================================
-- Migration: 0097_multi_signer_proposals.sql
--
-- Q34 — multi-signer proposals. The signatures table is already plural
-- (role/sequence/state/per-signer fields); this migration adds the
-- roster + linkage needed to require >=2 signers:
--   - signatures.required        — does this signer gate ACCEPTED?
--   - signatures.method nullable — PENDING roster rows have no method yet
--   - proposals.signing_order_mode — PARALLEL (default) | SEQUENTIAL
--   - magic_links.signature_id   — per-signer magic links
--
-- Backward compatible: existing accepted proposals keep their single
-- SIGNED row (required defaults true), legacy links keep signature_id
-- NULL, and proposals default to PARALLEL.
-- =====================================================================

-- Roster: every signer is required by default; WITNESS rows can be made
-- non-required so they don't gate acceptance.
ALTER TABLE vibetb.signatures
  ADD COLUMN IF NOT EXISTS required boolean NOT NULL DEFAULT true;

-- PENDING roster rows are inserted at send time before a signing method
-- is chosen. The existing signatures_method_payload CHECK already allows
-- a PENDING row (its "OR state = 'PENDING'" arm), so only the NOT NULL
-- needs relaxing.
ALTER TABLE vibetb.signatures
  ALTER COLUMN method DROP NOT NULL;

-- A DECLINED roster row also never has a signing method/payload (the
-- signer refused before choosing one). The original check only allowed
-- a null method for state='PENDING'; widen it to cover 'DECLINED' too so
-- the staff-recoverable decline flow can stamp the row. A *set* method
-- still requires its matching payload (so a DRAWN_SVG with no SVG remains
-- rejected regardless of state) — only a NULL method is exempted for
-- PENDING/DECLINED roster rows.
ALTER TABLE vibetb.signatures
  DROP CONSTRAINT IF EXISTS signatures_method_payload;
ALTER TABLE vibetb.signatures
  ADD CONSTRAINT signatures_method_payload CHECK (
    (method = 'TYPED_NAME' AND typed_name IS NOT NULL)
    OR (method = 'DRAWN_SVG' AND signature_svg IS NOT NULL)
    OR (method = 'OPENSIGN' AND opensign_envelope_id IS NOT NULL)
    OR (method IS NULL AND state IN ('PENDING', 'DECLINED'))
  );

-- Signing order: parallel (all links live at once, any order) by default;
-- sequential gates each signer behind the prior sequence.
ALTER TABLE vibetb.proposals
  ADD COLUMN IF NOT EXISTS signing_order_mode text NOT NULL DEFAULT 'PARALLEL';

DO $$ BEGIN
  ALTER TABLE vibetb.proposals
    ADD CONSTRAINT proposals_signing_order_mode_chk
    CHECK (signing_order_mode IN ('PARALLEL', 'SEQUENTIAL'));
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Per-signer magic links. Nullable so the legacy single-link flow and
-- other magic-link purposes are unaffected.
ALTER TABLE vibetb.magic_links
  ADD COLUMN IF NOT EXISTS signature_id uuid REFERENCES vibetb.signatures(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS magic_links_signature_idx ON vibetb.magic_links (signature_id);
