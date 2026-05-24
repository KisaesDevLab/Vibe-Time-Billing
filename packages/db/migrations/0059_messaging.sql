-- =====================================================================
-- Migration: 0059_messaging.sql
--
-- Engagement-level messaging — absorbed from Connect's design into TB
-- as a first-class feature. Standalone (no Connect dependency); the
-- repo is referenced only as a development pattern source.
--
-- Schema:
--   thread                    — one per engagement (1:1 enforced via
--                               engagement_thread_link)
--   thread_member             — staff + portal identities participating
--                               in a thread
--   message                   — encrypted at rest with a per-thread
--                               T-DEK. Body, attachments index, and
--                               sender id are visible plaintext; only
--                               the message body bytes are encrypted.
--   message_attachment        — links message → files row (file storage
--                               handles its own at-rest crypto)
--   message_read_receipt      — per-member, per-message
--   engagement_thread_link    — 1:1 engagement ↔ thread
--   time_entry_message_link   — links pre-bill time entries to the
--                               messages that informed them; many-to-
--                               many with a sequence column for stable
--                               ordering on the pre-bill UI.
--
-- Crypto model (matches Stage 1B FirmKeyManager):
--   firm has one MFK in memory (unsealed at boot)
--   each thread has its own T-DEK (per-thread Data Encryption Key)
--     - generated on thread create
--     - wrapped by MFK, stored as thread.t_dek_wrapped (bytea)
--     - unwrapped to plaintext on demand server-side, never leaves the
--       request lifetime; messages are encrypted with the unwrapped key
--   each message's body_ciphertext = XChaCha20-Poly1305(T-DEK, body)
--
-- Search path is vibetb,public (set in 0057). New tables go into
-- vibetb explicitly.
-- =====================================================================

-- ---------------------------------------------------------------------
-- thread
-- ---------------------------------------------------------------------
CREATE TABLE vibetb.thread (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  -- The wrapped per-thread DEK. XChaCha20-Poly1305(MFK, T-DEK).
  t_dek_wrapped bytea NOT NULL,
  -- Soft-delete state. ACTIVE while the engagement is open; ARCHIVED
  -- when the engagement archives (Q3 — message retention follows
  -- engagement lifetime).
  status text NOT NULL DEFAULT 'ACTIVE',
  -- Optional title; defaults to engagement name on create.
  title text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,

  CONSTRAINT thread_status_ck CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  CONSTRAINT thread_t_dek_size_ck CHECK (octet_length(t_dek_wrapped) BETWEEN 32 AND 256)
);

CREATE INDEX thread_firm_id_idx ON vibetb.thread(firm_id);
CREATE INDEX thread_status_idx ON vibetb.thread(status);

-- ---------------------------------------------------------------------
-- engagement_thread_link — 1:1 enforced via UNIQUE on both columns
-- ---------------------------------------------------------------------
CREATE TABLE vibetb.engagement_thread_link (
  engagement_id uuid PRIMARY KEY REFERENCES vibetb.engagement(id) ON DELETE CASCADE,
  thread_id uuid NOT NULL UNIQUE REFERENCES vibetb.thread(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- thread_member
-- ---------------------------------------------------------------------
-- Mutually-exclusive actor column (staff XOR portal identity). One row
-- per (thread, actor) pair.
CREATE TABLE vibetb.thread_member (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id uuid NOT NULL REFERENCES vibetb.thread(id) ON DELETE CASCADE,
  app_user_id uuid REFERENCES vibetb.app_user(id) ON DELETE CASCADE,
  portal_identity_id uuid REFERENCES vibetb.portal_identity(id) ON DELETE CASCADE,
  -- Role within the thread: 'partner', 'staff', 'client'. Used to scope
  -- read receipt UI ('partner saw it', 'client saw it' etc).
  member_role text NOT NULL,
  joined_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,

  CONSTRAINT thread_member_actor_ck CHECK (
    (app_user_id IS NOT NULL AND portal_identity_id IS NULL)
    OR (app_user_id IS NULL AND portal_identity_id IS NOT NULL)
  ),
  CONSTRAINT thread_member_role_ck
    CHECK (member_role IN ('partner', 'staff', 'client'))
);

CREATE UNIQUE INDEX thread_member_unique_staff_idx
  ON vibetb.thread_member(thread_id, app_user_id)
  WHERE app_user_id IS NOT NULL AND removed_at IS NULL;
CREATE UNIQUE INDEX thread_member_unique_portal_idx
  ON vibetb.thread_member(thread_id, portal_identity_id)
  WHERE portal_identity_id IS NOT NULL AND removed_at IS NULL;
CREATE INDEX thread_member_thread_id_idx ON vibetb.thread_member(thread_id);

-- ---------------------------------------------------------------------
-- message
-- ---------------------------------------------------------------------
CREATE TABLE vibetb.message (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id uuid NOT NULL REFERENCES vibetb.thread(id) ON DELETE CASCADE,
  -- Sender — mutually exclusive (staff XOR portal).
  sender_app_user_id uuid REFERENCES vibetb.app_user(id) ON DELETE SET NULL,
  sender_portal_identity_id uuid REFERENCES vibetb.portal_identity(id) ON DELETE SET NULL,
  -- Body encrypted with the thread's T-DEK. Plaintext is decrypted on
  -- read only; never written to disk or audit log.
  body_ciphertext bytea NOT NULL,
  -- Excerpt for list UI without decrypting full body. First N chars of
  -- plaintext at write time, stored plaintext (small leakage trade-off
  -- for list performance). Limited to 80 chars to keep leakage minimal.
  excerpt_plaintext text,
  -- Soft delete: once a message is sent it stays. Edits create a new
  -- row referencing the original via edit_of_id (chain-style edit
  -- history; older messages keep showing in audit trails).
  edit_of_id uuid REFERENCES vibetb.message(id) ON DELETE SET NULL,
  deleted_at timestamptz,
  deleted_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT message_sender_ck CHECK (
    (sender_app_user_id IS NOT NULL AND sender_portal_identity_id IS NULL)
    OR (sender_app_user_id IS NULL AND sender_portal_identity_id IS NOT NULL)
  ),
  CONSTRAINT message_body_size_ck
    CHECK (octet_length(body_ciphertext) BETWEEN 32 AND 1048576),
  CONSTRAINT message_excerpt_size_ck
    CHECK (excerpt_plaintext IS NULL OR length(excerpt_plaintext) <= 80)
);

CREATE INDEX message_thread_id_created_idx
  ON vibetb.message(thread_id, created_at DESC)
  WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------
-- message_attachment
-- ---------------------------------------------------------------------
-- Links a message to an existing files row (Files v2 owns the actual
-- blob storage + visibility flips). The attachment row inherits the
-- thread's privacy: if the file row is visibility='client_visible' the
-- attachment is visible to all thread members; visibility='private'
-- means staff-only; 'escrow' means pay-to-unlock.
CREATE TABLE vibetb.message_attachment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES vibetb.message(id) ON DELETE CASCADE,
  file_id uuid NOT NULL REFERENCES vibetb.files(id) ON DELETE CASCADE,
  attached_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX message_attachment_message_id_idx ON vibetb.message_attachment(message_id);
CREATE INDEX message_attachment_file_id_idx ON vibetb.message_attachment(file_id);

-- ---------------------------------------------------------------------
-- message_read_receipt
-- ---------------------------------------------------------------------
-- One row per (message, member) the first time a member opens the
-- thread past that message. Upserted on read; never updated.
CREATE TABLE vibetb.message_read_receipt (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES vibetb.message(id) ON DELETE CASCADE,
  -- Reader — mutually exclusive (staff XOR portal).
  reader_app_user_id uuid REFERENCES vibetb.app_user(id) ON DELETE CASCADE,
  reader_portal_identity_id uuid REFERENCES vibetb.portal_identity(id) ON DELETE CASCADE,
  read_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT mrr_reader_ck CHECK (
    (reader_app_user_id IS NOT NULL AND reader_portal_identity_id IS NULL)
    OR (reader_app_user_id IS NULL AND reader_portal_identity_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX mrr_unique_staff_idx
  ON vibetb.message_read_receipt(message_id, reader_app_user_id)
  WHERE reader_app_user_id IS NOT NULL;
CREATE UNIQUE INDEX mrr_unique_portal_idx
  ON vibetb.message_read_receipt(message_id, reader_portal_identity_id)
  WHERE reader_portal_identity_id IS NOT NULL;

-- ---------------------------------------------------------------------
-- time_entry_message_link
-- ---------------------------------------------------------------------
-- Pre-bill workflow: a time entry can cite the message(s) that drove
-- the work. Many-to-many; sequence column gives a stable display order
-- on the pre-bill UI when an entry cites multiple messages.
CREATE TABLE vibetb.time_entry_message_link (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  time_entry_id uuid NOT NULL REFERENCES vibetb.time_entry(id) ON DELETE CASCADE,
  message_id uuid NOT NULL REFERENCES vibetb.message(id) ON DELETE CASCADE,
  sequence integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT time_entry_message_link_unique UNIQUE (time_entry_id, message_id)
);

CREATE INDEX time_entry_message_link_te_idx ON vibetb.time_entry_message_link(time_entry_id);
CREATE INDEX time_entry_message_link_msg_idx ON vibetb.time_entry_message_link(message_id);
