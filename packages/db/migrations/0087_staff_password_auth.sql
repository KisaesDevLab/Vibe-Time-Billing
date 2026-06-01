-- =====================================================================
-- Migration: 0087_staff_password_auth.sql
--
-- Adds username/password sign-in for staff alongside the existing
-- magic-link flow. Each staff user picks ONE second factor at
-- enrollment: TOTP, email OTP, or SMS OTP. TOTP is no longer
-- universally mandatory (CLAUDE.md non-negotiable #5 is superseded;
-- see the locked-decision note that lands with this migration).
--
-- Columns added to app_user:
--   password_hash               argon2id digest (NULL → magic-link only).
--   password_set_at             when the password was first set.
--   sms_otp_phone_e164          E.164 phone verified at SMS-OTP enrollment.
--   sms_otp_enrolled_at         when SMS OTP was enrolled.
--   email_otp_enrolled_at       when email OTP was opted in.
--   preferred_second_factor     'TOTP' | 'EMAIL' | 'SMS'. NULL = auto-pick
--                               (TOTP if enrolled, else email, else SMS).
--
-- Existing totp_secret_encrypted + totp_enrolled_at + recovery_codes_*
-- columns continue to mean the same thing; we just stopped requiring
-- them on every account.
-- =====================================================================

CREATE TYPE second_factor_kind AS ENUM ('TOTP', 'EMAIL', 'SMS');

ALTER TABLE vibetb.app_user
  ADD COLUMN IF NOT EXISTS password_hash text,
  ADD COLUMN IF NOT EXISTS password_set_at timestamptz,
  ADD COLUMN IF NOT EXISTS sms_otp_phone_e164 text,
  ADD COLUMN IF NOT EXISTS sms_otp_enrolled_at timestamptz,
  ADD COLUMN IF NOT EXISTS email_otp_enrolled_at timestamptz,
  ADD COLUMN IF NOT EXISTS preferred_second_factor second_factor_kind;

-- E.164 sanity: leading '+', 8-15 digits. Cheap CHECK; full validation
-- happens at the API layer.
ALTER TABLE vibetb.app_user
  ADD CONSTRAINT app_user_sms_otp_phone_e164_ck
  CHECK (
    sms_otp_phone_e164 IS NULL
    OR sms_otp_phone_e164 ~ '^\+[1-9][0-9]{7,14}$'
  );

-- SMS OTP enrollment requires a phone number to dial.
ALTER TABLE vibetb.app_user
  ADD CONSTRAINT app_user_sms_otp_phone_when_enrolled_ck
  CHECK (
    sms_otp_enrolled_at IS NULL
    OR sms_otp_phone_e164 IS NOT NULL
  );

-- The preferred factor must actually be enrolled. We can't reference
-- the totp_enrolled_at NULL state in a single-row CHECK on a partial
-- column set, so the rule is: when preferred_second_factor is set, the
-- corresponding enrolled-at field must also be set.
ALTER TABLE vibetb.app_user
  ADD CONSTRAINT app_user_preferred_factor_enrolled_ck
  CHECK (
    preferred_second_factor IS NULL
    OR (preferred_second_factor = 'TOTP' AND totp_enrolled_at IS NOT NULL)
    OR (preferred_second_factor = 'EMAIL' AND email_otp_enrolled_at IS NOT NULL)
    OR (preferred_second_factor = 'SMS' AND sms_otp_enrolled_at IS NOT NULL)
  );

-- Index for password-login lookup. Email already has a unique index per
-- firm (app_user_firm_email_uk); no additional index needed for the
-- new columns since they're not queried in hot paths.
