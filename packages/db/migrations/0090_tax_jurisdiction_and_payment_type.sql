-- =====================================================================
-- Migration: 0090_tax_jurisdiction_and_payment_type.sql
--
-- Catalog tables for tax payments:
--   tax_jurisdiction       Federal, State - CA, Local - Oakland, …
--   tax_payment_type       Income Tax, Estimate, Tax Notice, …
--                          Each row belongs to a jurisdiction so the
--                          dropdown on the New Tax Payment form can
--                          filter types by the picked jurisdiction.
--                          Optional payment_url is what the portal
--                          links to so the client can pay online.
--
-- Existing tax_payment.jurisdiction and .payment_type columns stay
-- TEXT with no FK (historical rows survive catalog edits / deletes).
-- New rows additionally get the resolved payment_url denormalized
-- onto the tax_payment row at create time so the portal "Pay now"
-- link is stable even if the catalog entry is later edited or removed.
-- =====================================================================

CREATE TABLE IF NOT EXISTS vibetb.tax_jurisdiction (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id       uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  name          text NOT NULL,
  active        boolean NOT NULL DEFAULT true,
  display_order smallint NOT NULL DEFAULT 100,
  is_system     boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tax_jurisdiction_firm_name_uk UNIQUE (firm_id, name)
);

CREATE INDEX IF NOT EXISTS tax_jurisdiction_firm_active_order_idx
  ON vibetb.tax_jurisdiction(firm_id, active, display_order);

CREATE TABLE IF NOT EXISTS vibetb.tax_payment_type (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id         uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  jurisdiction_id uuid NOT NULL
    REFERENCES vibetb.tax_jurisdiction(id) ON DELETE CASCADE,
  name            text NOT NULL,
  payment_url     text,
  active          boolean NOT NULL DEFAULT true,
  display_order   smallint NOT NULL DEFAULT 100,
  is_system       boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tax_payment_type_juris_name_uk UNIQUE (jurisdiction_id, name)
);

CREATE INDEX IF NOT EXISTS tax_payment_type_firm_active_order_idx
  ON vibetb.tax_payment_type(firm_id, active, display_order);
CREATE INDEX IF NOT EXISTS tax_payment_type_jurisdiction_idx
  ON vibetb.tax_payment_type(jurisdiction_id);

-- Denormalize the payment URL onto each tax_payment row at create
-- time so historical rows keep a stable "Pay online" link even if
-- the firm later edits or deletes the catalog entry. Nullable.
ALTER TABLE vibetb.tax_payment
  ADD COLUMN IF NOT EXISTS payment_url text;

-- Backfill: every existing firm gets Federal + 5 starter payment
-- types. Idempotent via the unique constraints. Custom jurisdictions
-- the firm adds (state, local, etc.) sit alongside as non-system rows.
INSERT INTO vibetb.tax_jurisdiction (firm_id, name, display_order, is_system)
SELECT f.id, 'Federal', 10, true
FROM vibetb.firm f
ON CONFLICT (firm_id, name) DO NOTHING;

INSERT INTO vibetb.tax_payment_type
  (firm_id, jurisdiction_id, name, payment_url, display_order, is_system)
SELECT
  j.firm_id,
  j.id,
  v.name,
  v.url,
  v.display_order,
  true
FROM vibetb.tax_jurisdiction j
CROSS JOIN (
  VALUES
    ('Income Tax',  'https://www.irs.gov/payments', 10),
    ('Estimated Tax','https://www.eftps.gov',       20),
    ('Tax Notice',  'https://www.irs.gov/payments', 30),
    ('Extension',   'https://www.irs.gov/payments/extension-of-time-to-file', 40),
    ('Payroll Tax', 'https://www.eftps.gov',        50)
) AS v(name, url, display_order)
WHERE j.name = 'Federal' AND j.is_system = true
ON CONFLICT (jurisdiction_id, name) DO NOTHING;
