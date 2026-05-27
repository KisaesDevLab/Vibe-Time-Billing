-- =====================================================================
-- Migration: 0077_app_user_webauthn.sql
--
-- Phase 3 item #8 — optional WebAuthn / passkey enrollment for staff.
-- Each app_user can register one or more credentials (browser passkey,
-- security key, etc.). Successful auth via WebAuthn is treated as a
-- step-up event equivalent to a fresh TOTP code.
--
-- One row per credential. The credential_id is the unique handle the
-- authenticator returns at registration. Public key is stored as
-- base64url-encoded COSE bytes. sign_count is the replay-protection
-- counter the authenticator increments on every assertion — the server
-- rejects an assertion whose counter <= the stored value.
-- =====================================================================

CREATE TABLE IF NOT EXISTS app_user_credential (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_user_id        uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  credential_id      text NOT NULL,
  public_key         text NOT NULL,
  sign_count         bigint NOT NULL DEFAULT 0,
  transports         text NOT NULL DEFAULT '',  -- comma-joined: usb,nfc,ble,internal,hybrid
  label              text,                       -- user-friendly nickname
  aaguid             uuid,                       -- authenticator model id
  device_type        text,                       -- 'singleDevice' | 'multiDevice'
  backed_up          boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  last_used_at       timestamptz
);

-- Lookup by credentialId is the auth hot path.
CREATE UNIQUE INDEX IF NOT EXISTS app_user_credential_credential_uk
  ON app_user_credential(credential_id);

CREATE INDEX IF NOT EXISTS app_user_credential_user_idx
  ON app_user_credential(app_user_id);
