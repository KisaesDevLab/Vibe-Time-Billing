-- 0193 — manual ACH (bank routing/account) support for saved payment methods.
-- A bank added by routing+account number is verified asynchronously via Stripe
-- micro-deposits (1-2 business days). Until verified it must NOT be chargeable.
-- verification_status is NULL for ready/instant methods and cards; set to
-- 'PENDING_MICRODEPOSIT' while awaiting the two-deposit / descriptor-code
-- confirmation. pending_setup_intent_id holds the SetupIntent to verify against.
ALTER TABLE vibetb.payment_method
  ADD COLUMN IF NOT EXISTS verification_status text,
  ADD COLUMN IF NOT EXISTS pending_setup_intent_id text;
