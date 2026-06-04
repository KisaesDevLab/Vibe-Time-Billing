-- =====================================================================
-- Migration: 0102_unified_file_shares.sql
--
-- Bring the rich tax-return share capability to ALL files, and let staff
-- (not just portal clients) initiate shares.
--
--  * file_share gains recipient capture, watermark, status lifecycle,
--    view tracking, delivery stamp, 2FA scaffolding (stored; enforcement
--    phased), and a staff initiator column (created_by_app_user_id). The
--    token_hash now holds an argon2id hash for new rows; the public
--    redeem still accepts legacy sha256 tokens.
--  * tax_return_shares gains shared_by_app_user_id and relaxes
--    shared_by_access_id to nullable so staff can create shares too
--    (exactly one initiator set).
-- All additive / nullable-or-defaulted — safe on existing rows.
-- =====================================================================

ALTER TABLE vibetb.file_share
  ADD COLUMN IF NOT EXISTS created_by_app_user_id uuid,
  ADD COLUMN IF NOT EXISTS recipient_name text,
  ADD COLUMN IF NOT EXISTS recipient_email text,
  ADD COLUMN IF NOT EXISTS recipient_phone text,
  ADD COLUMN IF NOT EXISTS organization text,
  ADD COLUMN IF NOT EXISTS role text,
  ADD COLUMN IF NOT EXISTS personal_message text,
  ADD COLUMN IF NOT EXISTS require_2fa boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS verify_channel text NOT NULL DEFAULT 'NONE',
  ADD COLUMN IF NOT EXISTS watermark boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'SENT',
  ADD COLUMN IF NOT EXISTS first_viewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_viewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS delivered_at timestamptz;

ALTER TABLE vibetb.tax_return_shares
  ADD COLUMN IF NOT EXISTS shared_by_app_user_id uuid;
ALTER TABLE vibetb.tax_return_shares
  ALTER COLUMN shared_by_access_id DROP NOT NULL;
