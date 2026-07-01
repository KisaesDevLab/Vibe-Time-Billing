-- 0196 — firm mailing address, edited in Admin → Firm settings → Branding and
-- composed into the `firm.address` token already wired through invoice,
-- statement, letter, and email templates (previously always empty).
ALTER TABLE vibetb.firm_settings
  ADD COLUMN IF NOT EXISTS mailing_street1 text,
  ADD COLUMN IF NOT EXISTS mailing_street2 text,
  ADD COLUMN IF NOT EXISTS mailing_city text,
  ADD COLUMN IF NOT EXISTS mailing_state text,
  ADD COLUMN IF NOT EXISTS mailing_postal text,
  ADD COLUMN IF NOT EXISTS mailing_country text;
