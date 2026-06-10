-- 0139 — in-office (in-person) signing + tax-return linkage.
--
-- Adds an in-person signing mode to signature_requests (the client signs
-- on a staff device / their phone in the office, no email), a back-link to
-- the tax return a signature package was assembled from, and a package
-- manifest describing the merged parts (return signature pages + default
-- documents + ad-hoc docs) for display, the QR sheet, and audit.

ALTER TABLE vibetb.signature_requests
  ADD COLUMN signing_mode text NOT NULL DEFAULT 'remote'
    CHECK (signing_mode IN ('remote','in_person')),
  ADD COLUMN tax_return_id uuid REFERENCES vibetb.tax_returns(id) ON DELETE SET NULL,
  ADD COLUMN package_manifest jsonb;

CREATE INDEX IF NOT EXISTS signature_requests_tax_return_idx
  ON vibetb.signature_requests (tax_return_id);
