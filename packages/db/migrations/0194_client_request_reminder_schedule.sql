-- 0194 — multi-reminder scheduling for drop-offs (client_request kind=DROP_OFF).
-- Mirrors the appointment reminder model: a jsonb schedule of {offsetMinutes,
-- channel} steps on the request, plus a per-offset/channel sent-ledger for
-- idempotency (replacing the single last_reminder_sent_at flag for scheduled
-- reminders). The legacy reminder_days_before column stays for back-compat.
ALTER TABLE vibetb.client_request
  ADD COLUMN IF NOT EXISTS reminder_schedule jsonb;

CREATE TABLE IF NOT EXISTS vibetb.client_request_reminder_sent (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_request_id uuid NOT NULL REFERENCES vibetb.client_request(id) ON DELETE CASCADE,
  reminder_offset_minutes integer NOT NULL,
  channel text NOT NULL DEFAULT 'EMAIL',
  sent_at timestamptz NOT NULL DEFAULT now(),
  delivery_status text NOT NULL DEFAULT 'sent'
);

CREATE UNIQUE INDEX IF NOT EXISTS client_request_reminder_sent_uk
  ON vibetb.client_request_reminder_sent (client_request_id, reminder_offset_minutes, channel);
CREATE INDEX IF NOT EXISTS client_request_reminder_sent_req_idx
  ON vibetb.client_request_reminder_sent (client_request_id);
