-- =====================================================================
-- Migration: 0106_message_attachments.sql
--
-- Image/file attachments on messages (client + internal threads). Bytes
-- live at object_key encrypted under the thread T-DEK (same key as the
-- message body); the original filename is encrypted too. message_id is
-- null for a pending upload and set when the composing message is posted.
-- =====================================================================

CREATE TABLE IF NOT EXISTS vibetb.thread_attachment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  thread_id uuid NOT NULL REFERENCES vibetb.thread(id) ON DELETE CASCADE,
  message_id uuid REFERENCES vibetb.message(id) ON DELETE CASCADE,
  object_key text NOT NULL,
  original_filename_enc bytea,
  mime_type text,
  byte_size bigint NOT NULL,
  created_by_app_user_id uuid REFERENCES vibetb.app_user(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS thread_attachment_thread_idx ON vibetb.thread_attachment (thread_id);
CREATE INDEX IF NOT EXISTS thread_attachment_message_idx ON vibetb.thread_attachment (message_id);
