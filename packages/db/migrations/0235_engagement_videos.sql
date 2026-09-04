-- =====================================================================
-- Migration: 0235_engagement_videos.sql
--
-- Engagement videos — staff upload a video against an engagement; the
-- engagement's client streams it in the portal. Plays are logged per
-- portal identity; the object is deleted on the earlier of two clocks
-- (N days after upload / M days after first play) while the row is kept
-- as EXPIRED for history. Clients can reply to a video inside the
-- engagement's client thread — message.engagement_video_id tags those.
--
--   engagement_video        one per uploaded video
--   engagement_video_play   one per playback session (portal identity)
--   firm_settings           per-firm default retention clocks
--   message                 + engagement_video_id (reply tagging)
--
-- expires_at is application-maintained (LEAST of the non-null clocks),
-- never a generated column — the pglite test harness applies these
-- files verbatim. No `DO $$ ... $$` blocks.
-- =====================================================================

CREATE TABLE IF NOT EXISTS vibetb.engagement_video (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  engagement_id uuid NOT NULL REFERENCES vibetb.engagement(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES vibetb.client(id) ON DELETE CASCADE,
  title text NOT NULL,
  message text,
  original_filename text NOT NULL,
  mime_type text NOT NULL,
  size_bytes bigint NOT NULL,
  storage_key text NOT NULL,
  etag text,
  status text NOT NULL DEFAULT 'PENDING_UPLOAD',
  uploaded_by uuid REFERENCES vibetb.app_user(id) ON DELETE SET NULL,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  delete_after_days integer,
  delete_days_after_first_play integer,
  expires_at timestamptz,
  notify_client boolean NOT NULL DEFAULT false,
  notified_at timestamptz,
  first_played_at timestamptz,
  last_played_at timestamptz,
  play_count integer NOT NULL DEFAULT 0,
  max_progress_pct real,
  expired_at timestamptz,
  deleted_at timestamptz,
  deleted_by uuid REFERENCES vibetb.app_user(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT engagement_video_mime_ck
    CHECK (mime_type IN ('video/mp4', 'video/quicktime', 'video/webm')),
  CONSTRAINT engagement_video_status_ck
    CHECK (status IN ('PENDING_UPLOAD', 'AVAILABLE', 'EXPIRED', 'DELETED')),
  CONSTRAINT engagement_video_size_ck CHECK (size_bytes >= 0),
  CONSTRAINT engagement_video_clocks_ck
    CHECK (
      (delete_after_days IS NULL OR delete_after_days >= 1)
      AND (delete_days_after_first_play IS NULL OR delete_days_after_first_play >= 1)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS engagement_video_firm_storage_key_uk
  ON vibetb.engagement_video (firm_id, storage_key);
CREATE INDEX IF NOT EXISTS engagement_video_engagement_idx
  ON vibetb.engagement_video (engagement_id, status);
CREATE INDEX IF NOT EXISTS engagement_video_client_idx
  ON vibetb.engagement_video (client_id, status)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS engagement_video_expiry_idx
  ON vibetb.engagement_video (expires_at)
  WHERE status = 'AVAILABLE' AND expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS engagement_video_pending_idx
  ON vibetb.engagement_video (uploaded_at)
  WHERE status = 'PENDING_UPLOAD';

CREATE TABLE IF NOT EXISTS vibetb.engagement_video_play (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id uuid NOT NULL REFERENCES vibetb.engagement_video(id) ON DELETE CASCADE,
  portal_identity_id uuid NOT NULL REFERENCES vibetb.portal_identity(id) ON DELETE CASCADE,
  started_at timestamptz NOT NULL DEFAULT now(),
  last_heartbeat_at timestamptz NOT NULL DEFAULT now(),
  furthest_seconds real NOT NULL DEFAULT 0,
  duration_seconds real,
  completed boolean NOT NULL DEFAULT false,
  ip text,
  user_agent text,
  device_kind text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS engagement_video_play_video_idx
  ON vibetb.engagement_video_play (video_id, started_at);
CREATE INDEX IF NOT EXISTS engagement_video_play_identity_idx
  ON vibetb.engagement_video_play (portal_identity_id, video_id);

ALTER TABLE vibetb.firm_settings
  ADD COLUMN IF NOT EXISTS video_default_delete_after_days integer DEFAULT 30,
  ADD COLUMN IF NOT EXISTS video_default_delete_days_after_play integer DEFAULT 3;

ALTER TABLE vibetb.message
  ADD COLUMN IF NOT EXISTS engagement_video_id uuid
    REFERENCES vibetb.engagement_video(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS message_engagement_video_idx
  ON vibetb.message (engagement_video_id)
  WHERE engagement_video_id IS NOT NULL;
