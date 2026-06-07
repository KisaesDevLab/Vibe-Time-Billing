-- 0127_retainer_offer_copy.sql
-- Proposal-style offer copy for the retainer offer presentation + printable
-- handout. Firm-controlled intro paragraph + representation terms, both
-- Markdown. Rendered on the portal offer page and the PDF/print view.

ALTER TABLE vibetb.firm_retainer_settings
  ADD COLUMN IF NOT EXISTS offer_intro_md text,
  ADD COLUMN IF NOT EXISTS offer_terms_md text;
