-- =====================================================================
-- Migration: 0030_client_communication.sql
--
-- v2 Sprint C — communications timeline (workstream 1.5). Every
-- outbound email/SMS from the notification dispatcher emits a row here
-- (always-on, locked decision). Inbound + internal entries (call notes,
-- meeting recap) are staff-recorded via the Communications tab UI.
--
-- channel + direction are loose enums (TEXT + CHECK) rather than
-- pg_enum to keep migration friction low if we add channels later.
-- relatedEntityType + relatedEntityId let the timeline link back to
-- whichever business object triggered the message (invoice, letter,
-- approval, etc.) without a hard FK.
-- =====================================================================

CREATE TABLE IF NOT EXISTS client_communication (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id UUID NOT NULL REFERENCES firm(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES client(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('EMAIL', 'SMS', 'CALL', 'MEETING', 'NOTE')),
  direction TEXT NOT NULL CHECK (direction IN ('INBOUND', 'OUTBOUND', 'INTERNAL')),
  subject TEXT,
  body TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  recorded_by_id UUID REFERENCES app_user(id) ON DELETE SET NULL,
  related_entity_type TEXT,
  related_entity_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS client_communication_client_idx
  ON client_communication (client_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS client_communication_firm_idx
  ON client_communication (firm_id, occurred_at DESC);
