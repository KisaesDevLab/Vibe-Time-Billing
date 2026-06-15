-- =====================================================================
-- Migration: 0161_portal_push_subscriptions.sql
--
-- Web Push subscriptions for the installable client-portal PWA. One row per
-- browser/device endpoint, bound to a portal_identity (the person). The worker
-- sends a push whenever a portal_notification is created; dead endpoints
-- (404/410 from the push service) are pruned on send.
--
-- NOTE: no `DO $$ ... $$` blocks (the pglite test harness strips them);
-- bare statements only. The migrate runner wraps each file in one txn.
-- =====================================================================

CREATE TABLE IF NOT EXISTS vibetb.portal_push_subscription (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  portal_identity_id uuid NOT NULL REFERENCES vibetb.portal_identity(id) ON DELETE CASCADE,
  endpoint text NOT NULL UNIQUE,
  p256dh text NOT NULL,
  auth text NOT NULL,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  failure_count integer NOT NULL DEFAULT 0,
  disabled_at timestamptz
);

CREATE INDEX IF NOT EXISTS portal_push_subscription_identity_idx
  ON vibetb.portal_push_subscription (portal_identity_id);
