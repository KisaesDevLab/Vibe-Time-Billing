-- =====================================================================
-- Migration: 0004_dunning_history.sql
--
-- Per-invoice dunning ledger (Phase 15 #10). The dunning-sweep worker
-- reads this table to compute alreadySentKinds and writes a row when it
-- dispatches a step. UNIQUE on (invoice_id, step_kind) makes "already
-- sent" a single point-lookup and bounds the table size.
-- =====================================================================

CREATE TABLE IF NOT EXISTS dunning_history (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id      UUID NOT NULL REFERENCES invoice(id) ON DELETE CASCADE,
  step_kind       TEXT NOT NULL,
  sent_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  channel         TEXT,        -- 'EMAIL' | 'SMS' | null
  recipient       TEXT,        -- the email/phone we dispatched to (no secrets)
  outcome         TEXT NOT NULL DEFAULT 'SENT', -- 'SENT' | 'FAILED'
  error_message   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (invoice_id, step_kind)
);

CREATE INDEX IF NOT EXISTS dunning_history_invoice_idx
  ON dunning_history (invoice_id);
CREATE INDEX IF NOT EXISTS dunning_history_sent_at_idx
  ON dunning_history (sent_at);
