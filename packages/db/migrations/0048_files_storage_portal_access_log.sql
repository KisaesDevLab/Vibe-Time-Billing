-- =====================================================================
-- Migration: 0048_files_storage_portal_access_log.sql
--
-- Phase 11 of the file-manager rebuild — append-only log of portal
-- file accesses. Each row records who downloaded what and when, plus
-- the source IP + user-agent fingerprint. The audit_log table doesn't
-- carry firm_id / file_id directly and would dilute the read-side
-- "what has this client looked at" query, so we split file accesses
-- off into their own table.
--
-- Also serves the addendum §3.5 "First viewed in portal" UX:
-- file_visibility_events records publish/unpublish flips; this table
-- records which `client_visible` files the portal user actually
-- opened. Staff can ask "Has the client opened invoice 42?" without
-- joining against the noisier audit_log.
--
-- file_id may be nullable when the row records a failed access
-- attempt (e.g. file deleted between list and download); the actor +
-- requested key still go in via the `requested_storage_key` column.
-- =====================================================================

CREATE TABLE IF NOT EXISTS file_access_log (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id                UUID NOT NULL REFERENCES firm(id),
  file_id                UUID REFERENCES files(id) ON DELETE SET NULL,
  client_id              UUID NOT NULL REFERENCES client(id) ON DELETE CASCADE,
  portal_identity_id     UUID,
  requested_storage_key  TEXT,
  -- 'allowed' | 'denied_visibility' | 'denied_ownership' | 'denied_rate_limit'
  -- | 'denied_not_found' | 'denied_pending' | 'denied_deleted'
  outcome                TEXT NOT NULL,
  ip                     TEXT,
  user_agent             TEXT,
  occurred_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT file_access_log_outcome_chk CHECK (
    outcome IN (
      'allowed',
      'denied_visibility',
      'denied_ownership',
      'denied_rate_limit',
      'denied_not_found',
      'denied_pending',
      'denied_deleted'
    )
  )
);

-- Hot index for "this file's audit timeline" + "this client's access log".
CREATE INDEX IF NOT EXISTS idx_file_access_log_file
  ON file_access_log (file_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_file_access_log_client
  ON file_access_log (client_id, occurred_at DESC);
