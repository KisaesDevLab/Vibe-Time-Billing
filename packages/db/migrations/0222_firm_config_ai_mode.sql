-- 0222 — AI routing mode is now a firm setting (Admin → AI settings) instead
-- of only the VIBE_AI_MODE env var. 'env' keeps the appliance default; the
-- router token is MFK-wrapped like the provider API keys.
ALTER TABLE vibetb.firm_config
  ADD COLUMN IF NOT EXISTS ai_mode text NOT NULL DEFAULT 'env',
  ADD COLUMN IF NOT EXISTS ai_router_url text,
  ADD COLUMN IF NOT EXISTS ai_router_token_encrypted bytea,
  ADD COLUMN IF NOT EXISTS ai_router_token_hint text,
  ADD COLUMN IF NOT EXISTS ai_router_status text NOT NULL DEFAULT 'UNTESTED',
  ADD COLUMN IF NOT EXISTS ai_router_last_error text,
  ADD COLUMN IF NOT EXISTS ai_router_last_tested_at timestamptz;
ALTER TABLE vibetb.firm_config
  DROP CONSTRAINT IF EXISTS firm_config_ai_mode_ck;
ALTER TABLE vibetb.firm_config
  ADD CONSTRAINT firm_config_ai_mode_ck CHECK (ai_mode IN ('env', 'direct', 'router'));
