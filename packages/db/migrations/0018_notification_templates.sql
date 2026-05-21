-- =====================================================================
-- Migration: 0018_notification_templates.sql
--
-- Per-firm customizable notification templates (Phase 20 #12).
-- Per Q28: variable insertion only, no HTML editor, no Markdown.
-- Templates are stored as text with {{variable}} markers. Handlebars-
-- style substitution happens at render time.
--
-- One row per (firm_id, kind, channel). When a row exists for a given
-- (kind, channel), the dispatcher uses it; otherwise falls back to the
-- baked-in default in @vibe/core/notifications.
-- =====================================================================

CREATE TABLE IF NOT EXISTS notification_template (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  firm_id UUID NOT NULL REFERENCES firm(id) ON DELETE CASCADE,
  -- kind: 'invoice_sent', 'invoice_overdue', 'dunning_first', 'dunning_second',
  --       'payment_received', 'magic_link', 'sms_otp', etc.
  kind TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('EMAIL', 'SMS')),

  subject TEXT,
  body TEXT NOT NULL,

  -- Cached list of placeholders found in body+subject for the UI's
  -- variable picker.
  variables_json JSONB,

  enabled BOOLEAN NOT NULL DEFAULT true,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT notification_template_uk UNIQUE (firm_id, kind, channel)
);

CREATE INDEX IF NOT EXISTS notification_template_firm_kind_idx
  ON notification_template (firm_id, kind);
