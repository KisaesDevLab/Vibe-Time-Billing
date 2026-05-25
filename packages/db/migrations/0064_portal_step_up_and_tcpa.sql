-- P4.3 + P4.4 — Connect addendum H.5 + I.3/I.4
--
-- (1) portal_identity gains TCPA SMS-consent columns. NULL means "no
--     consent on file" — SMS senders MUST check sms_consent_at IS NOT
--     NULL before delivering to a portal_identity. We persist the
--     literal text the user agreed to (regulator audit), the version
--     we showed (so we know which copy was active at consent time),
--     when they agreed, and from what IP.
--
-- (2) portal_step_up_challenge tracks elevated-verification challenges
--     issued to portal sessions. One row per outstanding challenge;
--     completed_at stamps success, attempts tracks failed responses.
--     Distinct from the staff `step_up_verifications` table because
--     portal challenges have different mechanisms (ssn-last-4, ein,
--     email-otp) and different expiration / lockout rules.

-- --- (1) portal_identity TCPA columns -----------------------------

ALTER TABLE vibetb.portal_identity
  ADD COLUMN IF NOT EXISTS sms_consent_text    text,
  ADD COLUMN IF NOT EXISTS sms_consent_version text,
  ADD COLUMN IF NOT EXISTS sms_consent_at      timestamptz,
  ADD COLUMN IF NOT EXISTS sms_consent_ip      text;

-- Index lets us quickly find identities missing consent for a TCPA
-- audit sweep ("show me every identity with a verified phone but no
-- SMS consent on file").
CREATE INDEX IF NOT EXISTS portal_identity_sms_consent_idx
  ON vibetb.portal_identity (firm_id, sms_consent_at)
  WHERE primary_phone IS NOT NULL;

-- --- (2) portal_step_up_challenge ---------------------------------

CREATE TABLE IF NOT EXISTS vibetb.portal_step_up_challenge (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id             uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  portal_identity_id  uuid NOT NULL REFERENCES vibetb.portal_identity(id) ON DELETE CASCADE,
  active_client_id    uuid REFERENCES vibetb.client(id) ON DELETE SET NULL,
  challenge_type      text NOT NULL,                                -- 'ssn-last-4' | 'ein' | 'email-otp' | 'sms-otp'
  -- For OTP variants: hashed OTP (sha256 hex). NULL for knowledge-
  -- factor challenges (ssn/ein) where the value is held by the
  -- caller and compared on /verify directly.
  otp_hash            text,
  -- Free-form intent — what the user was trying to do when challenged.
  -- Logged in audit trail on completion / failure.
  reason              text,
  issued_at           timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,
  completed_at        timestamptz,
  attempts            integer NOT NULL DEFAULT 0,
  CHECK (challenge_type IN ('ssn-last-4', 'ein', 'email-otp', 'sms-otp'))
);

CREATE INDEX IF NOT EXISTS portal_step_up_challenge_identity_idx
  ON vibetb.portal_step_up_challenge (portal_identity_id, issued_at DESC);

CREATE INDEX IF NOT EXISTS portal_step_up_challenge_open_idx
  ON vibetb.portal_step_up_challenge (portal_identity_id)
  WHERE completed_at IS NULL;
