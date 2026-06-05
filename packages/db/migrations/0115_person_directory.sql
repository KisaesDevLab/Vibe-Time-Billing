-- =====================================================================
-- Migration: 0115_person_directory.sql
--
-- Introduce a firm-global `person` table as the canonical source of
-- name/email/phone for the firm directory. The same human who is a
-- contact on several clients is now ONE person row with many
-- client_contact rows; portal_identity links to the same person.
--
-- Strategy: EXPAND/CONTRACT. This migration is purely additive — it
-- creates person, adds person_id links, and backfills. The legacy
-- client_contact columns (full_name/email/phone/mobile) are RETAINED
-- this release so the existing readers keep working; a follow-up (0116)
-- drops them once all code reads through person. full_name's NOT NULL is
-- relaxed here since the canonical name now lives on person.
--
-- NOTE: do NOT wrap DDL in `DO $$ BEGIN IF NOT EXISTS ... END $$` — the
-- pglite test harness strips that shape. Use bare IF NOT EXISTS.
-- The migrate runner wraps each file in one transaction (no CONCURRENTLY).
-- =====================================================================

-- 1. person ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS vibetb.person (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id     uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  full_name   text NOT NULL,
  email       text,
  phone       text,
  mobile      text,
  status      entity_status NOT NULL DEFAULT 'ACTIVE',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS person_firm_idx ON vibetb.person (firm_id);

-- Email is the canonical, firm-unique identity key (NULLs allowed/many).
CREATE UNIQUE INDEX IF NOT EXISTS person_firm_email_uk
  ON vibetb.person (firm_id, lower(email)) WHERE email IS NOT NULL;

-- Phone/mobile are NON-unique lookup keys — shared numbers (spouses,
-- a business's staff) are legitimate, so phone is a dedup hint only.
CREATE INDEX IF NOT EXISTS person_firm_phone_idx
  ON vibetb.person (firm_id, phone) WHERE phone IS NOT NULL;
CREATE INDEX IF NOT EXISTS person_firm_mobile_idx
  ON vibetb.person (firm_id, mobile) WHERE mobile IS NOT NULL;

-- 2. client_contact: add the canonical link (nullable until backfilled).
ALTER TABLE vibetb.client_contact
  ADD COLUMN IF NOT EXISTS person_id uuid
    REFERENCES vibetb.person(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS client_contact_person_idx
  ON vibetb.client_contact (person_id);

-- 3a. One person per (firm, lower(email)); link the email-bearing contacts.
INSERT INTO vibetb.person (firm_id, full_name, email, phone, mobile, status)
SELECT DISTINCT ON (c.firm_id, lower(cc.email))
       c.firm_id,
       cc.full_name,
       cc.email,
       nullif(cc.phone, ''),
       nullif(cc.mobile, ''),
       'ACTIVE'
FROM vibetb.client_contact cc
JOIN vibetb.client c ON c.id = cc.client_id
WHERE nullif(cc.email, '') IS NOT NULL
ORDER BY c.firm_id, lower(cc.email), cc.is_primary DESC, cc.created_at ASC
ON CONFLICT DO NOTHING;

UPDATE vibetb.client_contact cc
SET person_id = p.id
FROM vibetb.person p, vibetb.client c
WHERE c.id = cc.client_id
  AND c.firm_id = p.firm_id
  AND cc.person_id IS NULL
  AND nullif(cc.email, '') IS NOT NULL
  AND p.email IS NOT NULL
  AND lower(p.email) = lower(cc.email);

-- 3b. Emailless contacts grouped by digits-only phone -> person; link only
--     to email-less persons so we never merge across the email boundary.
INSERT INTO vibetb.person (firm_id, full_name, email, phone, mobile, status)
SELECT DISTINCT ON (c.firm_id,
        regexp_replace(coalesce(nullif(cc.phone,''), nullif(cc.mobile,'')), '\D', '', 'g'))
       c.firm_id, cc.full_name, NULL,
       nullif(cc.phone,''), nullif(cc.mobile,''), 'ACTIVE'
FROM vibetb.client_contact cc
JOIN vibetb.client c ON c.id = cc.client_id
WHERE cc.person_id IS NULL
  AND nullif(cc.email,'') IS NULL
  AND coalesce(nullif(cc.phone,''), nullif(cc.mobile,'')) IS NOT NULL
ORDER BY c.firm_id,
         regexp_replace(coalesce(nullif(cc.phone,''), nullif(cc.mobile,'')), '\D','','g'),
         cc.is_primary DESC, cc.created_at ASC;

UPDATE vibetb.client_contact cc
SET person_id = p.id
FROM vibetb.person p, vibetb.client c
WHERE c.id = cc.client_id
  AND c.firm_id = p.firm_id
  AND cc.person_id IS NULL
  AND nullif(cc.email,'') IS NULL
  AND p.email IS NULL
  AND coalesce(p.phone, p.mobile) IS NOT NULL
  AND regexp_replace(coalesce(p.phone, p.mobile), '\D','','g')
    = regexp_replace(coalesce(nullif(cc.phone,''), nullif(cc.mobile,'')), '\D','','g');

-- 3c. Keyless contacts (no email, no phone): one person each, mapped 1:1
--     through a temp column dropped at the end of this transaction.
ALTER TABLE vibetb.person ADD COLUMN IF NOT EXISTS backfill_src_contact_id uuid;

INSERT INTO vibetb.person (firm_id, full_name, status, backfill_src_contact_id)
SELECT c.firm_id, cc.full_name, 'ACTIVE', cc.id
FROM vibetb.client_contact cc
JOIN vibetb.client c ON c.id = cc.client_id
WHERE cc.person_id IS NULL;

UPDATE vibetb.client_contact cc
SET person_id = p.id
FROM vibetb.person p
WHERE p.backfill_src_contact_id = cc.id
  AND cc.person_id IS NULL;

ALTER TABLE vibetb.person DROP COLUMN IF EXISTS backfill_src_contact_id;

-- 4. Lock the link now that every contact is mapped; relax legacy name.
ALTER TABLE vibetb.client_contact ALTER COLUMN person_id SET NOT NULL;
ALTER TABLE vibetb.client_contact ALTER COLUMN full_name DROP NOT NULL;

-- 5. portal_identity links to person (keeps its own login credentials).
ALTER TABLE vibetb.portal_identity
  ADD COLUMN IF NOT EXISTS person_id uuid
    REFERENCES vibetb.person(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS portal_identity_person_idx
  ON vibetb.portal_identity (person_id);

UPDATE vibetb.portal_identity pi
SET person_id = p.id
FROM vibetb.person p
WHERE pi.person_id IS NULL
  AND p.firm_id = pi.firm_id
  AND pi.primary_email IS NOT NULL
  AND p.email IS NOT NULL
  AND lower(p.email) = lower(pi.primary_email);

-- Phone fallback only when exactly one firm person matches (phone is
-- non-unique; ambiguous shared numbers are left for lazy reconciliation).
UPDATE vibetb.portal_identity pi
SET person_id = sub.pid
FROM (
  SELECT pi2.id AS iid, min(p.id::text)::uuid AS pid, count(*) AS n
  FROM vibetb.portal_identity pi2
  JOIN vibetb.person p
    ON p.firm_id = pi2.firm_id
   AND pi2.primary_phone IS NOT NULL
   AND coalesce(p.phone, p.mobile) IS NOT NULL
   AND regexp_replace(coalesce(p.phone, p.mobile), '\D','','g')
     = regexp_replace(pi2.primary_phone, '\D','','g')
  WHERE pi2.person_id IS NULL
  GROUP BY pi2.id
) sub
WHERE pi.id = sub.iid AND sub.n = 1;
