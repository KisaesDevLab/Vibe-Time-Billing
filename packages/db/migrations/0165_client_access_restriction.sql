-- =====================================================================
-- Migration: 0165_client_access_restriction.sql
--
-- Per-client visibility restriction. When client.restricted = true the
-- client's non-billing data ("everything else": engagements, time, files,
-- tasks, notes, communications, requests, appointments, tax, credentials,
-- retainers/proposals/signatures) is hidden from staff who are not an
-- admin, the partner-in-charge, or an explicitly designated user.
-- Designated users live in client_access_grant. Basic data (client info,
-- people/contacts, billing/A-R) stays visible to all staff.
--
-- NOTE: no `DO $$ ... $$` blocks (the pglite test harness strips them);
-- bare statements only. The migrate runner wraps each file in one txn.
-- =====================================================================

ALTER TABLE vibetb.client
  ADD COLUMN IF NOT EXISTS restricted boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS client_restricted_idx
  ON vibetb.client (firm_id)
  WHERE restricted;

CREATE TABLE IF NOT EXISTS vibetb.client_access_grant (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES vibetb.client (id) ON DELETE CASCADE,
  app_user_id uuid NOT NULL REFERENCES vibetb.app_user (id) ON DELETE CASCADE,
  granted_at timestamptz NOT NULL DEFAULT now(),
  granted_by_id uuid REFERENCES vibetb.app_user (id)
);

CREATE UNIQUE INDEX IF NOT EXISTS client_access_grant_uk
  ON vibetb.client_access_grant (client_id, app_user_id);

CREATE INDEX IF NOT EXISTS client_access_grant_client_idx
  ON vibetb.client_access_grant (client_id);

CREATE INDEX IF NOT EXISTS client_access_grant_user_idx
  ON vibetb.client_access_grant (app_user_id);
