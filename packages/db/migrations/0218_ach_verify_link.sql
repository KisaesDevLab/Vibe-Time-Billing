-- 0218 — public ACH micro-deposit verification links (no portal login).
-- Mirrors invoice_pay_link (0181): the opaque ~128-bit token IS the
-- credential; only its sha256 is stored. A link lets the holder verify
-- the micro-deposit amounts for ONE pending manual-ACH payment method.
CREATE TABLE IF NOT EXISTS ach_verify_link (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES firm(id) ON DELETE CASCADE,
  payment_method_id uuid NOT NULL REFERENCES payment_method(id) ON DELETE CASCADE,
  -- sha256(token) hex — the plaintext token is never stored or logged.
  token_hash text NOT NULL UNIQUE,
  -- ACTIVE | VERIFIED | VOIDED | EXPIRED. Multiple ACTIVE links may coexist
  -- for one method (each reminder mints its own).
  status text NOT NULL DEFAULT 'ACTIVE',
  expires_at timestamptz,
  created_by_app_user_id uuid REFERENCES app_user(id) ON DELETE SET NULL,
  access_count integer NOT NULL DEFAULT 0,
  last_accessed_at timestamptz,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ach_verify_link_method_idx ON ach_verify_link(payment_method_id);
CREATE INDEX IF NOT EXISTS ach_verify_link_firm_status_idx ON ach_verify_link(firm_id, status);
