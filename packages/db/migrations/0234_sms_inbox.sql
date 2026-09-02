-- =====================================================================
-- Migration: 0234_sms_inbox.sql
--
-- Two-way SMS inbox (Twilio) — phase 2: the conversation model.
--
--   person            + phone_e164 / mobile_e164 (trigger-maintained,
--                       indexed — the inbound lookup key), opt-out
--                       provenance, consent (D8a)
--   sms_conversation  one per (line, external number)
--   sms_message       inbound + outbound, provider status, read state
--   sms_media         inbound MMS → object storage → Document Intake
--   sms_template      quick-reply library (firm / user scope)
--
-- Consent backfill: D8a blocks outbound-initiated texts to people with no
-- consent record. Without a backfill every reminder would stop the day
-- this ships, so anyone the firm has successfully texted in the last 12
-- months (notification_log) is marked consent_source='legacy'.
--
-- NOTE: no `DO $$ ... $$` blocks (the pglite test harness strips them);
-- plain CREATE FUNCTION bodies are fine (0002 precedent). Migrate runner
-- wraps each file in one txn.
-- =====================================================================

-- ----- person: normalized numbers + opt-out provenance + consent -------

-- Mirrors packages/core normalizePhone (US-biased): 10 digits → +1…,
-- 11 digits starting with 1 → +…, explicit '+' passthrough, else NULL.
CREATE OR REPLACE FUNCTION vibetb.normalize_phone_e164(raw text)
RETURNS text AS $$
DECLARE
  d text;
BEGIN
  IF raw IS NULL THEN
    RETURN NULL;
  END IF;
  d := regexp_replace(raw, '\D', '', 'g');
  IF length(d) = 10 THEN
    RETURN '+1' || d;
  ELSIF length(d) = 11 AND left(d, 1) = '1' THEN
    RETURN '+' || d;
  ELSIF left(btrim(raw), 1) = '+' AND length(d) >= 8 THEN
    RETURN '+' || d;
  END IF;
  RETURN NULL;
END
$$ LANGUAGE plpgsql IMMUTABLE;

ALTER TABLE vibetb.person
  ADD COLUMN IF NOT EXISTS phone_e164 text,
  ADD COLUMN IF NOT EXISTS mobile_e164 text,
  ADD COLUMN IF NOT EXISTS sms_opt_out_at timestamptz,
  ADD COLUMN IF NOT EXISTS sms_opt_out_source text,
  ADD COLUMN IF NOT EXISTS sms_consent_at timestamptz,
  ADD COLUMN IF NOT EXISTS sms_consent_source text,
  ADD COLUMN IF NOT EXISTS sms_consent_by_user_id uuid
    REFERENCES vibetb.app_user(id) ON DELETE SET NULL;

ALTER TABLE vibetb.person DROP CONSTRAINT IF EXISTS person_sms_consent_source_ck;
ALTER TABLE vibetb.person ADD CONSTRAINT person_sms_consent_source_ck
  CHECK (sms_consent_source IS NULL
         OR sms_consent_source IN ('inbound', 'booking', 'portal', 'verbal', 'staff', 'legacy'));

CREATE OR REPLACE FUNCTION vibetb.person_sync_phone_e164()
RETURNS trigger AS $$
BEGIN
  NEW.phone_e164 := vibetb.normalize_phone_e164(NEW.phone);
  NEW.mobile_e164 := vibetb.normalize_phone_e164(NEW.mobile);
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS person_sync_phone_e164_trg ON vibetb.person;
CREATE TRIGGER person_sync_phone_e164_trg
  BEFORE INSERT OR UPDATE OF phone, mobile ON vibetb.person
  FOR EACH ROW EXECUTE FUNCTION vibetb.person_sync_phone_e164();

UPDATE vibetb.person
   SET phone_e164 = vibetb.normalize_phone_e164(phone),
       mobile_e164 = vibetb.normalize_phone_e164(mobile);

CREATE INDEX IF NOT EXISTS person_firm_mobile_e164_idx
  ON vibetb.person (firm_id, mobile_e164) WHERE mobile_e164 IS NOT NULL;
CREATE INDEX IF NOT EXISTS person_firm_phone_e164_idx
  ON vibetb.person (firm_id, phone_e164) WHERE phone_e164 IS NOT NULL;

-- Existing opt-outs (0224) predate provenance tracking.
UPDATE vibetb.person
   SET sms_opt_out_at = COALESCE(sms_opt_out_at, updated_at),
       sms_opt_out_source = COALESCE(sms_opt_out_source, 'staff')
 WHERE sms_opt_out = true;

-- Legacy consent: successfully texted in the last 12 months.
UPDATE vibetb.person p
   SET sms_consent_at = now(),
       sms_consent_source = 'legacy'
 WHERE p.sms_consent_at IS NULL
   AND p.sms_opt_out = false
   AND (p.mobile_e164 IS NOT NULL OR p.phone_e164 IS NOT NULL)
   AND EXISTS (
     SELECT 1
       FROM vibetb.notification_log n
      WHERE n.channel = 'sms'
        AND n.status IN ('sent', 'delivered')
        AND n.occurred_at > now() - interval '12 months'
        AND vibetb.normalize_phone_e164(n.recipient) IN (p.mobile_e164, p.phone_e164)
   );

-- ----- sms_conversation ------------------------------------------------

CREATE TABLE IF NOT EXISTS vibetb.sms_conversation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  line_id uuid NOT NULL REFERENCES vibetb.sms_line(id) ON DELETE RESTRICT,
  external_number_e164 text NOT NULL,
  person_id uuid REFERENCES vibetb.person(id) ON DELETE SET NULL,
  client_contact_id uuid REFERENCES vibetb.client_contact(id) ON DELETE SET NULL,
  client_id uuid REFERENCES vibetb.client(id) ON DELETE SET NULL,
  engagement_id uuid REFERENCES vibetb.engagement(id) ON DELETE SET NULL,
  engagement_suggested boolean NOT NULL DEFAULT false,
  -- how the client link was made; 'manual' is never overridden by re-matching
  link_source text NOT NULL DEFAULT 'none'
    CHECK (link_source IN ('none', 'reply_context', 'phone', 'manual')),
  needs_triage boolean NOT NULL DEFAULT false,
  candidate_person_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  assigned_user_id uuid REFERENCES vibetb.app_user(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'spam')),
  last_message_at timestamptz,
  last_inbound_at timestamptz,
  last_outbound_at timestamptz,
  unread_count integer NOT NULL DEFAULT 0,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sms_conversation_line_number_uk UNIQUE (line_id, external_number_e164)
);

CREATE INDEX IF NOT EXISTS sms_conversation_firm_last_idx
  ON vibetb.sms_conversation (firm_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS sms_conversation_client_idx
  ON vibetb.sms_conversation (client_id) WHERE client_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS sms_conversation_person_idx
  ON vibetb.sms_conversation (person_id) WHERE person_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS sms_conversation_engagement_idx
  ON vibetb.sms_conversation (engagement_id) WHERE engagement_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS sms_conversation_unread_idx
  ON vibetb.sms_conversation (firm_id, assigned_user_id) WHERE unread_count > 0;
CREATE INDEX IF NOT EXISTS sms_conversation_number_idx
  ON vibetb.sms_conversation (firm_id, external_number_e164);

-- ----- sms_message -----------------------------------------------------

CREATE TABLE IF NOT EXISTS vibetb.sms_message (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES vibetb.sms_conversation(id) ON DELETE CASCADE,
  direction text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  from_e164 text NOT NULL,
  to_e164 text NOT NULL,
  body text NOT NULL DEFAULT '',
  provider_message_id text,
  -- Twilio message status vocabulary + our own 'dead_letter' (Phase 13).
  provider_status text NOT NULL DEFAULT 'queued'
    CHECK (provider_status IN ('queued', 'accepted', 'scheduled', 'sending', 'sent', 'delivered',
                               'undelivered', 'failed', 'received', 'receiving', 'canceled',
                               'dead_letter')),
  provider_error_code integer,
  provider_error_message text,
  num_segments integer,
  num_media integer NOT NULL DEFAULT 0,
  -- why the outbound was sent / how the inbound arrived
  context_kind text NOT NULL DEFAULT 'manual'
    CHECK (context_kind IN ('manual', 'appointment_reminder', 'booking', 'client_request',
                            'notification', 'voice_fallback', 'auto_reply', 'inbound')),
  engagement_id uuid REFERENCES vibetb.engagement(id) ON DELETE SET NULL,
  sent_by_user_id uuid REFERENCES vibetb.app_user(id) ON DELETE SET NULL,
  appointment_id uuid REFERENCES vibetb.appointment(id) ON DELETE SET NULL,
  booking_request_id uuid REFERENCES vibetb.booking_request(id) ON DELETE SET NULL,
  client_request_id uuid REFERENCES vibetb.client_request(id) ON DELETE SET NULL,
  -- Twilio OptOutType when Advanced Opt-Out handled STOP/START/HELP
  opt_out_type text,
  -- D13 — parsed appointment-reply intent
  parsed_intent text CHECK (parsed_intent IS NULL OR parsed_intent IN ('confirm', 'reschedule')),
  read_at timestamptz,
  read_by_user_id uuid REFERENCES vibetb.app_user(id) ON DELETE SET NULL,
  redaction_flags jsonb NOT NULL DEFAULT '[]'::jsonb,
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  dead_lettered_at timestamptz,
  provider_timestamp timestamptz,
  ingest_source text NOT NULL DEFAULT 'api'
    CHECK (ingest_source IN ('webhook', 'poll', 'api')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS sms_message_provider_id_uk
  ON vibetb.sms_message (provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS sms_message_conversation_idx
  ON vibetb.sms_message (conversation_id, created_at);
CREATE INDEX IF NOT EXISTS sms_message_reply_ctx_idx
  ON vibetb.sms_message (firm_id, to_e164, created_at DESC) WHERE direction = 'outbound';
CREATE INDEX IF NOT EXISTS sms_message_stuck_idx
  ON vibetb.sms_message (created_at)
  WHERE direction = 'outbound' AND provider_status IN ('queued', 'accepted', 'sending', 'sent');
CREATE INDEX IF NOT EXISTS sms_message_unread_idx
  ON vibetb.sms_message (conversation_id) WHERE direction = 'inbound' AND read_at IS NULL;
CREATE INDEX IF NOT EXISTS sms_message_appointment_idx
  ON vibetb.sms_message (appointment_id) WHERE appointment_id IS NOT NULL;

-- ----- sms_media -------------------------------------------------------

CREATE TABLE IF NOT EXISTS vibetb.sms_media (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  message_id uuid NOT NULL REFERENCES vibetb.sms_message(id) ON DELETE CASCADE,
  provider_media_sid text,
  provider_media_url text,
  storage_key text,
  content_type text,
  size_bytes bigint,
  sha256 text,
  intake_session_id uuid REFERENCES vibetb.intake_sessions(id) ON DELETE SET NULL,
  intake_file_id uuid REFERENCES vibetb.intake_files(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'stored', 'intake', 'failed')),
  remote_deleted boolean NOT NULL DEFAULT false,
  error text,
  attempt_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sms_media_message_sid_uk UNIQUE (message_id, provider_media_sid)
);

CREATE INDEX IF NOT EXISTS sms_media_message_idx ON vibetb.sms_media (message_id);
CREATE INDEX IF NOT EXISTS sms_media_status_idx ON vibetb.sms_media (firm_id, status);

-- Intake sessions can now originate from an MMS (Phase 4).
ALTER TABLE vibetb.intake_sessions DROP CONSTRAINT IF EXISTS intake_sessions_source_check;
ALTER TABLE vibetb.intake_sessions DROP CONSTRAINT IF EXISTS intake_sessions_source_ck;
ALTER TABLE vibetb.intake_sessions ADD CONSTRAINT intake_sessions_source_ck
  CHECK (source IN ('public', 'tokenized_link', 'sms'));

-- ----- sms_template ----------------------------------------------------

CREATE TABLE IF NOT EXISTS vibetb.sms_template (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  scope text NOT NULL CHECK (scope IN ('firm', 'user')),
  owner_user_id uuid REFERENCES vibetb.app_user(id) ON DELETE CASCADE,
  name text NOT NULL,
  body text NOT NULL,
  variables jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sms_template_firm_idx
  ON vibetb.sms_template (firm_id, scope, owner_user_id);
