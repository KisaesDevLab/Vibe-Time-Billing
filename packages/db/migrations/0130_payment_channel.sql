-- 0130_payment_channel.sql
-- Explicit collection channel on a payment when known (e.g. 'TERMINAL' for an
-- in-person card_present charge). NULL means derive from provider + method.

ALTER TABLE vibetb.payment
  ADD COLUMN IF NOT EXISTS channel text;
