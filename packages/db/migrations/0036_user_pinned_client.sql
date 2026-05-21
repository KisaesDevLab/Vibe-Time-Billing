-- =====================================================================
-- Migration: 0036_user_pinned_client.sql
--
-- v2 followup — per-timekeeper pinned clients. The Time entry quick log
-- combobox + Clients list both float pinned clients to the top.
--
-- Primary key on (app_user_id, client_id) so pin/unpin is idempotent.
-- =====================================================================

CREATE TABLE IF NOT EXISTS user_pinned_client (
  app_user_id UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES client(id) ON DELETE CASCADE,
  pinned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (app_user_id, client_id)
);

CREATE INDEX IF NOT EXISTS user_pinned_client_user_idx
  ON user_pinned_client (app_user_id, pinned_at DESC);
