-- =====================================================================
-- Migration: 0034_taxonomy_extensions.sql
--
-- v2 Sprint B — new taxonomy tables required by the Create Client wizard
-- (workstream 3.6):
--
--   client_source   — lead source (referral, website, advisor, walk-in)
--   contact_role    — contact role within a client (OWNER, CFO, SPOUSE, etc.)
--
-- Both are firm-scoped, support archive (entity_status), and seed
-- sensible defaults so the dropdowns are populated on first install.
-- The FK from client.source_id and client_contact.role_id added at the
-- end (deferred from 0026 / 0027).
-- =====================================================================

CREATE TABLE IF NOT EXISTS client_source (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id UUID NOT NULL REFERENCES firm(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  status entity_status NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS client_source_firm_key_uk
  ON client_source (firm_id, key);

CREATE TABLE IF NOT EXISTS contact_role (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id UUID NOT NULL REFERENCES firm(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  status entity_status NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS contact_role_firm_key_uk
  ON contact_role (firm_id, key);

-- Seed defaults for every existing firm. Future firms get the same
-- defaults via the seed script (extended in Sprint B too).
INSERT INTO client_source (firm_id, key, name)
SELECT f.id, src.key, src.name
FROM firm f
CROSS JOIN (VALUES
  ('referral', 'Referral'),
  ('advisor', 'Advisor'),
  ('website', 'Website'),
  ('walk_in', 'Walk-in'),
  ('linkedin', 'LinkedIn'),
  ('cold_outreach', 'Cold outreach'),
  ('other', 'Other')
) AS src(key, name)
ON CONFLICT DO NOTHING;

INSERT INTO contact_role (firm_id, key, name)
SELECT f.id, r.key, r.name
FROM firm f
CROSS JOIN (VALUES
  ('owner', 'Owner'),
  ('spouse', 'Spouse'),
  ('partner', 'Partner'),
  ('cfo', 'CFO'),
  ('controller', 'Controller'),
  ('bookkeeper', 'Bookkeeper'),
  ('tax_preparer', 'Tax preparer'),
  ('assistant', 'Assistant'),
  ('other', 'Other')
) AS r(key, name)
ON CONFLICT DO NOTHING;

-- Now that the taxonomies exist, add the deferred FKs from
-- client.source_id (added in 0026) and client_contact.role_id (0027).
-- ON DELETE SET NULL so archiving a source/role doesn't cascade-delete
-- the client/contact.
ALTER TABLE client
  ADD CONSTRAINT client_source_fk
    FOREIGN KEY (source_id) REFERENCES client_source(id) ON DELETE SET NULL;

ALTER TABLE client_contact
  ADD CONSTRAINT client_contact_role_fk
    FOREIGN KEY (role_id) REFERENCES contact_role(id) ON DELETE SET NULL;
