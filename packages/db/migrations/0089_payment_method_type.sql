-- =====================================================================
-- Migration: 0089_payment_method_type.sql
--
-- Firm-editable catalog of manually-recorded payment methods (the
-- dropdown in the Receive Payment form). Replaces the hard-coded list
-- with rows the firm can rename, deactivate, or add to.
--
-- The existing payment.payment_method column stays TEXT with no FK so
-- historical rows survive any catalog edit. Validation happens at the
-- API zod layer against the firm's active catalog (plus the synthetic
-- CARD_STRIPE and CREDIT_APPLY values that the receive flow injects
-- based on context — Stripe wired / open credit memo).
--
-- Built-ins (CHECK, CASH, ACH_MANUAL, OTHER) seed with is_system=true
-- so they can be renamed and deactivated but not deleted. CARD_STRIPE
-- and CREDIT_APPLY are NOT seeded — they're synthetic.
-- =====================================================================

CREATE TABLE IF NOT EXISTS vibetb.payment_method_type (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id       uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  key           text NOT NULL,
  label         text NOT NULL,
  active        boolean NOT NULL DEFAULT true,
  display_order smallint NOT NULL DEFAULT 100,
  is_system     boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_method_type_firm_key_uk UNIQUE (firm_id, key),
  -- UPPER_SNAKE to match the legacy hard-coded values (CHECK, CASH,
  -- ACH_MANUAL, OTHER) so existing payment.payment_method strings keep
  -- resolving against the catalog.
  CONSTRAINT payment_method_type_key_format_ck
    CHECK (key ~ '^[A-Z][A-Z0-9_]{0,62}[A-Z0-9]$')
);

CREATE INDEX IF NOT EXISTS payment_method_type_firm_idx
  ON vibetb.payment_method_type(firm_id);
CREATE INDEX IF NOT EXISTS payment_method_type_firm_active_order_idx
  ON vibetb.payment_method_type(firm_id, active, display_order);

-- Seed built-ins for every existing firm. Idempotent (ON CONFLICT skips
-- if a row already exists with the same firm_id + key).
INSERT INTO vibetb.payment_method_type (firm_id, key, label, display_order, is_system)
SELECT f.id, v.key, v.label, v.display_order, true
FROM vibetb.firm f
CROSS JOIN (
  VALUES
    ('CHECK',      'Check',         10),
    ('CASH',       'Cash',          20),
    ('ACH_MANUAL', 'ACH (manual)',  30),
    ('OTHER',      'Other',         99)
) AS v(key, label, display_order)
ON CONFLICT (firm_id, key) DO NOTHING;
