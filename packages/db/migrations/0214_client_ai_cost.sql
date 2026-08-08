-- =====================================================================
-- Migration: 0214_client_ai_cost.sql
--
-- A1 (MIG-8 cost recovery): per-client AI usage synced from the Vibe AI
-- Router billing feed (GET /v1/billing/usage). One row per
-- (period, client, engagement, app, task class) — the feed is already a
-- full-period aggregate, so the sync job replace-upserts on the natural
-- key. `app` is kept because the feed is firm-scoped, not app-scoped:
-- T&B is the suite's billing hub and may ingest other Vibe apps' usage.
-- Cost lives here (router ledger truth), NOT in ai_request_log, which
-- deliberately records 0 cents in router mode.
-- =====================================================================

CREATE TABLE IF NOT EXISTS vibetb.client_ai_cost (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  period text NOT NULL,                -- 'yyyymm', half-open UTC month
  client_id uuid NOT NULL REFERENCES vibetb.client(id) ON DELETE CASCADE,
  engagement_id uuid REFERENCES vibetb.engagement(id) ON DELETE SET NULL,
  app text NOT NULL,                   -- e.g. 'vibe-time-billing'
  task_class text,                     -- e.g. 'tb_invoice_narrative'
  requests integer NOT NULL DEFAULT 0,
  prompt_tokens bigint NOT NULL DEFAULT 0,
  completion_tokens bigint NOT NULL DEFAULT 0,
  cost_cents bigint NOT NULL DEFAULT 0,
  synced_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT client_ai_cost_period_chk CHECK (period ~ '^[0-9]{6}$'),
  -- NULLS NOT DISTINCT (PG15+): engagement_id/task_class are nullable
  -- dimensions; two NULLs must still collide so the upsert stays 1:1.
  CONSTRAINT client_ai_cost_natural_uk
    UNIQUE NULLS NOT DISTINCT (firm_id, period, client_id, engagement_id, app, task_class)
);

CREATE INDEX IF NOT EXISTS client_ai_cost_firm_period_idx
  ON vibetb.client_ai_cost (firm_id, period);
