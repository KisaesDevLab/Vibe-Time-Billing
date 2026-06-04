-- =====================================================================
-- Migration: 0100_ai_provider_credentials.sql
--
-- UI-entered AI provider credentials + a 'direct' cloud-egress mode.
--
--  * ai_provider_credential: per-firm, one row per provider kind. API
--    keys are MFK-wrapped (bytea) like the Cloudflare tunnel token;
--    plaintext never lands here and is surfaced to the UI only as a
--    last-4 hint. The env/boot providers stay the fallback.
--  * firm_config.ai_egress_mode: 'shield' (default, unchanged behavior)
--    or 'direct' (call the provider API directly — firm key + budget +
--    audit, no Vibe Shield required).
-- =====================================================================

DO $$ BEGIN
  CREATE TYPE ai_provider_kind AS ENUM ('anthropic', 'openai_compatible', 'ollama');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS vibetb.ai_provider_credential (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  provider_id ai_provider_kind NOT NULL,
  api_key_encrypted bytea,
  api_key_hint text,
  base_url text,
  model text,
  input_cents_per_mtok integer,
  output_cents_per_mtok integer,
  enabled boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'UNTESTED',
  last_error text,
  last_tested_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ai_provider_credential_firm_provider_uk
  ON vibetb.ai_provider_credential (firm_id, provider_id);
CREATE INDEX IF NOT EXISTS ai_provider_credential_firm_idx
  ON vibetb.ai_provider_credential (firm_id);

ALTER TABLE vibetb.firm_config
  ADD COLUMN IF NOT EXISTS ai_egress_mode text NOT NULL DEFAULT 'shield';
