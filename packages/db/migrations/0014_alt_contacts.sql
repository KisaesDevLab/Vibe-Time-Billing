-- =====================================================================
-- Migration: 0014_alt_contacts.sql
--
-- Alternate-contact OTP support for portal identities (Phase 19 #22).
-- Each portal_identity already has a primary_email + primary_phone with
-- their own verified-at timestamps; alternate contacts go in a separate
-- table so the (identity, channel, value) grain is explicit and each
-- one carries its own verification state, attempts, and rate-limit
-- bookkeeping.
--
-- Lifecycle:
--   1. POST /portal/me/alt-contacts  → row inserted with verified_at=NULL,
--      otp_hash + otp_expires_at set
--   2. Identity receives code via the chosen channel
--   3. POST /portal/me/alt-contacts/:id/verify { code } sets verified_at
--   4. DELETE /portal/me/alt-contacts/:id removes it
--
-- Storage is hashed (SHA-256) per security invariant. Limits live on
-- the row so a missing Redis or hot path can still enforce them.
-- =====================================================================

CREATE TABLE IF NOT EXISTS portal_alt_contact (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  portal_identity_id UUID NOT NULL
    REFERENCES portal_identity(id) ON DELETE CASCADE,

  channel TEXT NOT NULL CHECK (channel IN ('EMAIL', 'SMS')),
  value TEXT NOT NULL,

  -- Verification state
  verified_at TIMESTAMPTZ,

  -- OTP material (hashed SHA-256). Cleared when verified_at is set.
  otp_hash TEXT,
  otp_expires_at TIMESTAMPTZ,
  otp_attempts INTEGER NOT NULL DEFAULT 0,
  otp_last_sent_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- One row per (identity, channel, value). Re-adding the same address
  -- updates the existing row's OTP rather than duplicating it.
  CONSTRAINT portal_alt_contact_unique UNIQUE (portal_identity_id, channel, value)
);

CREATE INDEX IF NOT EXISTS portal_alt_contact_identity_idx
  ON portal_alt_contact (portal_identity_id);
