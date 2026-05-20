-- =====================================================================
-- Migration: 0006_notes.sql
--
-- Engagement and client note threads (Phase 6 #4, Phase 8 #16). Per-row
-- audit trail of free-text notes attached to a client or engagement.
-- Multi-line. Edits are immutable — new note rows supersede older ones.
-- =====================================================================

CREATE TABLE IF NOT EXISTS client_note (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     UUID NOT NULL REFERENCES client(id) ON DELETE CASCADE,
  author_id     UUID NOT NULL REFERENCES app_user(id),
  body          TEXT NOT NULL,
  pinned        BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS client_note_client_idx ON client_note (client_id, created_at DESC);

CREATE TABLE IF NOT EXISTS engagement_note (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  engagement_id   UUID NOT NULL REFERENCES engagement(id) ON DELETE CASCADE,
  author_id       UUID NOT NULL REFERENCES app_user(id),
  body            TEXT NOT NULL,
  pinned          BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS engagement_note_eng_idx ON engagement_note (engagement_id, created_at DESC);

-- Approval comment thread (Phase 18 #11).
CREATE TABLE IF NOT EXISTS approval_comment (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id      UUID NOT NULL REFERENCES approval_request(id) ON DELETE CASCADE,
  author_id       UUID NOT NULL REFERENCES app_user(id),
  body            TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS approval_comment_request_idx ON approval_comment (request_id, created_at);
