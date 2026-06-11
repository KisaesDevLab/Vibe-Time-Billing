-- =====================================================================
-- Migration: 0150_gated_file_shares.sql
--
-- Gated landing page for externally shared files. New shares stop
-- direct-downloading from /api/shared/<token>; the link now opens a
-- branded portal page (/shared/file/<token>) where the visitor
-- requests a one-time access code delivered to the share's recipient
-- email/SMS. A forwarded link is useless without control of that
-- channel.
--
--   gated            — false for every pre-existing row (legacy links
--                      keep direct-downloading until they expire, per
--                      owner decision); column default flips to true so
--                      all NEW shares are gated.
--   file_share_otp   — one row per "send code": sha256-hashed 6-digit
--                      code, 10-min expiry, attempt counter (5 locks
--                      the challenge; 3 exhausted challenges revoke
--                      the share), and the browser grant minted on
--                      verify (sha256 at rest, 30-min TTL). A table —
--                      not Redis — so cooldown/quota are row counts,
--                      state survives restarts, and pglite tests cover
--                      the whole flow (the tax-share OTP stalled on
--                      "Redis wiring later"; not repeating that).
--
-- NOTE: no `DO $$ ... $$` blocks (the pglite test harness strips them);
-- bare statements only. Migrate runner wraps each file in one txn.
-- =====================================================================

ALTER TABLE vibetb.file_share
  ADD COLUMN IF NOT EXISTS gated boolean NOT NULL DEFAULT false;
ALTER TABLE vibetb.file_share
  ALTER COLUMN gated SET DEFAULT true;

CREATE TABLE IF NOT EXISTS vibetb.file_share_otp (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_share_id     uuid NOT NULL REFERENCES vibetb.file_share(id) ON DELETE CASCADE,
  -- 'EMAIL' | 'SMS'
  channel           text NOT NULL,
  -- sha256 hex of the 6-digit code (hash-all-tokens-at-rest invariant)
  code_hash         text NOT NULL,
  expires_at        timestamptz NOT NULL,
  attempts          integer NOT NULL DEFAULT 0,
  locked_at         timestamptz,
  verified_at       timestamptz,
  -- sha256 hex of the 32-byte browser grant minted on verify
  grant_token_hash  text,
  grant_expires_at  timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT file_share_otp_channel_ck CHECK (channel IN ('EMAIL', 'SMS')),
  CONSTRAINT file_share_otp_attempts_nonneg CHECK (attempts >= 0)
);

CREATE INDEX IF NOT EXISTS file_share_otp_share_idx
  ON vibetb.file_share_otp (file_share_id, created_at);

-- Widen the access-event vocabulary for the gated flow.
ALTER TABLE vibetb.file_share_event
  DROP CONSTRAINT IF EXISTS file_share_event_outcome_ck;
ALTER TABLE vibetb.file_share_event
  ADD CONSTRAINT file_share_event_outcome_ck
  CHECK (outcome IN (
    'allowed', 'denied_revoked', 'denied_expired', 'denied_file_gone',
    'otp_sent', 'otp_failed', 'otp_verified', 'otp_locked',
    'denied_gated', 'denied_not_verified', 'revoked_lockout'
  ));
