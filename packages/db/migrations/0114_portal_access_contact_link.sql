-- =====================================================================
-- Migration: 0114_portal_access_contact_link.sql
--
-- Reconcile the two ways a person appears on a client: client_contact
-- (the firm's directory) and client_portal_access (a login grant). They
-- were unlinked, so the same human showed in both the Contacts and
-- Portal Access cards with no connection. Add an OPTIONAL link from an
-- access row to the contact it represents.
--
-- NULL is meaningful: a 3rd party (outside CPA, attorney, advisor) can
-- have portal access without being a contact of the client — those rows
-- keep client_contact_id NULL and surface as "portal only".
--
-- Backfill links existing accesses to a same-client contact by matching
-- email (the common case; phone normalization differs, so phone-only
-- matches are reconciled lazily by the unified people endpoint).
-- =====================================================================

ALTER TABLE vibetb.client_portal_access
  ADD COLUMN IF NOT EXISTS client_contact_id uuid
    REFERENCES vibetb.client_contact(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS client_portal_access_contact_idx
  ON vibetb.client_portal_access (client_contact_id);

UPDATE vibetb.client_portal_access cpa
SET client_contact_id = cc.id
FROM vibetb.portal_identity pi, vibetb.client_contact cc
WHERE cpa.portal_identity_id = pi.id
  AND cc.client_id = cpa.client_id
  AND cpa.client_contact_id IS NULL
  AND pi.primary_email IS NOT NULL
  AND cc.email IS NOT NULL
  AND lower(cc.email) = lower(pi.primary_email);
