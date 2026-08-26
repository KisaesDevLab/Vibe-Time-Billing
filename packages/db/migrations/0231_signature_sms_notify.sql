-- =====================================================================
-- Migration: 0231_signature_sms_notify.sql
--
-- Deliver a signature request by text as well as by email. Signers gain
-- an optional phone (prefilled from the person's mobile when the signer
-- is picked out of the client's people list); the request carries the
-- channel the firm chose at send time, persisted because a sequential
-- send notifies the remaining signers later, from reconcile.
--
-- 'EMAIL' stays the default, so every existing request keeps behaving
-- exactly as it did.
--
-- NOTE: no `DO $$ ... $$` blocks (the pglite test harness strips them);
-- bare statements only. Migrate runner wraps each file in one txn.
-- =====================================================================

ALTER TABLE vibetb.signature_signers ADD COLUMN phone text;

ALTER TABLE vibetb.signature_requests
  ADD COLUMN notify_channel text NOT NULL DEFAULT 'EMAIL';
ALTER TABLE vibetb.signature_requests
  ADD CONSTRAINT signature_requests_notify_channel_ck
  CHECK (notify_channel IN ('EMAIL', 'SMS', 'BOTH'));
