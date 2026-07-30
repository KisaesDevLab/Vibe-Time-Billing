-- =====================================================================
-- Migration: 0213_ai_provider_vibe_router.sql
--
-- MIG-8: ai_request_log rows can now attribute a request to the Vibe AI
-- Router (VIBE_AI_MODE=router). New enum value appended last to match the
-- schema union order.
-- =====================================================================

ALTER TYPE ai_provider ADD VALUE IF NOT EXISTS 'VIBE_ROUTER';
