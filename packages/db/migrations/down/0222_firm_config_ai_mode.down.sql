ALTER TABLE vibetb.firm_config DROP CONSTRAINT IF EXISTS firm_config_ai_mode_ck;
ALTER TABLE vibetb.firm_config
  DROP COLUMN IF EXISTS ai_mode,
  DROP COLUMN IF EXISTS ai_router_url,
  DROP COLUMN IF EXISTS ai_router_token_encrypted,
  DROP COLUMN IF EXISTS ai_router_token_hint,
  DROP COLUMN IF EXISTS ai_router_status,
  DROP COLUMN IF EXISTS ai_router_last_error,
  DROP COLUMN IF EXISTS ai_router_last_tested_at;
