-- Destructive down (documented repo pattern): removing an enum value
-- requires a type rebuild; rows logged via the router are deleted first.
DELETE FROM ai_request_log WHERE provider = 'VIBE_ROUTER';
ALTER TYPE ai_provider RENAME TO ai_provider_old;
CREATE TYPE ai_provider AS ENUM ('LOCAL_OLLAMA', 'LOCAL_LLAMACPP', 'ANTHROPIC', 'OPENAI_COMPATIBLE');
ALTER TABLE ai_request_log ALTER COLUMN provider TYPE ai_provider USING provider::text::ai_provider;
DROP TYPE ai_provider_old;
