-- =====================================================================
-- Migration: 0181_invoice_pay_link.sql
--
-- Pay-by-link: let a client pay an invoice WITHOUT logging into the
-- portal. One invoice_pay_link row per generated link; the opaque token
-- (sha256 at rest) is the credential. The public /api/pay surface reads
-- it to open a Stripe Checkout Session; the Stripe webhook settles the
-- payment into the existing payment ledger and flips the link to PAID.
--
-- Also adds invoice_reminder_log.channel so the 24h dunning cooldown is
-- computed per delivery channel (an EMAIL reminder and an SMS payment
-- request are independent sends). Existing rows default to EMAIL,
-- preserving their original meaning.
-- =====================================================================

ALTER TABLE vibetb.invoice_reminder_log
  ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'EMAIL';

CREATE TABLE IF NOT EXISTS vibetb.invoice_pay_link (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES vibetb.firm (id) ON DELETE CASCADE,
  invoice_id uuid NOT NULL REFERENCES vibetb.invoice (id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'ACTIVE',
  expires_at timestamptz,
  created_by_app_user_id uuid REFERENCES vibetb.app_user (id) ON DELETE SET NULL,
  stripe_session_id text,
  access_count integer NOT NULL DEFAULT 0,
  last_accessed_at timestamptz,
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS invoice_pay_link_invoice_idx
  ON vibetb.invoice_pay_link (invoice_id);

CREATE INDEX IF NOT EXISTS invoice_pay_link_firm_status_idx
  ON vibetb.invoice_pay_link (firm_id, status);
