-- =====================================================================
-- Migration: 0027_client_contact.sql
--
-- v2 Sprint B — multi-contact per client (workstream 1.2). Replaces the
-- single billing-contact columns on client with a one-to-many
-- client_contact table. The existing billing_contact_name/email/phone
-- values migrate into a seeded contact row marked isPrimary=true and
-- isBilling=true. After the backfill, the legacy columns are dropped.
--
-- role_id is added as a nullable UUID without an FK constraint here —
-- the contact_role taxonomy + FK land together in 0034.
--
-- isPortalIdentity is informational; the actual portal_identity link
-- remains in client_portal_access (cross-realm — locked decision #2).
-- =====================================================================

CREATE TABLE IF NOT EXISTS client_contact (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES client(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL,
  role_id UUID,
  email TEXT,
  phone TEXT,
  mobile TEXT,
  is_primary BOOLEAN NOT NULL DEFAULT false,
  is_billing BOOLEAN NOT NULL DEFAULT false,
  is_portal_identity BOOLEAN NOT NULL DEFAULT false,
  status entity_status NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS client_contact_client_idx ON client_contact (client_id);
CREATE INDEX IF NOT EXISTS client_contact_email_idx ON client_contact (lower(email)) WHERE email IS NOT NULL;

-- At most one isPrimary=true per client.
CREATE UNIQUE INDEX IF NOT EXISTS client_contact_primary_uk
  ON client_contact (client_id)
  WHERE is_primary = true;
-- At most one isBilling=true per client.
CREATE UNIQUE INDEX IF NOT EXISTS client_contact_billing_uk
  ON client_contact (client_id)
  WHERE is_billing = true;

-- Backfill: every client with a populated billing_contact_name (or email
-- or phone) gets a seeded contact row. Clients with NO billing info
-- still get a contact row with the firm-known full name + isPrimary,
-- so every client has at least one contact going forward.
INSERT INTO client_contact (
  client_id, full_name, email, phone, is_primary, is_billing
)
SELECT
  id,
  COALESCE(NULLIF(billing_contact_name, ''), name),
  NULLIF(billing_contact_email, ''),
  NULLIF(billing_contact_phone, ''),
  true,
  CASE
    WHEN billing_contact_name IS NOT NULL
      OR billing_contact_email IS NOT NULL
      OR billing_contact_phone IS NOT NULL
    THEN true
    ELSE false
  END
FROM client;

-- Drop the now-redundant columns. billing_address stays for now —
-- addresses are a distinct concept (mailing vs billing vs physical)
-- and will get their own treatment in a later sprint.
ALTER TABLE client
  DROP COLUMN IF EXISTS billing_contact_name,
  DROP COLUMN IF EXISTS billing_contact_email,
  DROP COLUMN IF EXISTS billing_contact_phone;
