-- 0206 — configurable Twilio voice calls (appointment reminders + staged
-- client notifications). A separate voice Twilio account is stored
-- encrypted on firm_settings (mirroring sms_config_encrypted); persons
-- gain a global do-not-call flag (press 9 on any call, or staff-set);
-- CALL templates can override the firm's default voice; and every
-- outbound call gets an outcome row for auditing + voicemail/SMS-fallback
-- bookkeeping.

ALTER TABLE vibetb.firm_settings
  ADD COLUMN IF NOT EXISTS voice_config_encrypted text,
  ADD COLUMN IF NOT EXISTS voice_config_updated_at timestamptz;

ALTER TABLE vibetb.person
  ADD COLUMN IF NOT EXISTS do_not_call boolean NOT NULL DEFAULT false;

ALTER TABLE vibetb.notification_template
  ADD COLUMN IF NOT EXISTS voice text;

CREATE TABLE IF NOT EXISTS vibetb.voice_call (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  kind text NOT NULL,                        -- e.g. 'appointment_reminder', 'engagement_status:...', 'test'
  to_number text NOT NULL,
  person_id uuid REFERENCES vibetb.person(id) ON DELETE SET NULL,
  client_id uuid REFERENCES vibetb.client(id) ON DELETE SET NULL,
  appointment_id uuid REFERENCES vibetb.appointment(id) ON DELETE SET NULL,
  staged_notification_id uuid REFERENCES vibetb.staged_notification(id) ON DELETE SET NULL,
  -- Rendered script + the SMS body to send if the call can't connect.
  script text NOT NULL,
  fallback_sms_body text,
  voice text,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','placed','answered','voicemail','no_answer','busy',
                      'failed','opted_out','fallback_sms','canceled')),
  provider_call_sid text,
  error text,
  fallback_sms_sent boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  placed_at timestamptz,
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS voice_call_firm_created_idx
  ON vibetb.voice_call (firm_id, created_at DESC);
CREATE INDEX IF NOT EXISTS voice_call_sid_idx
  ON vibetb.voice_call (provider_call_sid);
