-- =====================================================================
-- Migration: 0166_contact_status_notification_optin.sql
--
-- Per-contact opt-in for engagement status notifications, mirroring the
-- existing receive_appointment_reminders flag. The staged
-- status-notification recipient resolution honors this: a contact with
-- receive_status_notifications = false is excluded from the snapshot.
-- Defaults to true so existing contacts keep receiving notifications.
--
-- NOTE: no `DO $$ ... $$` blocks (the pglite test harness strips them);
-- bare statements only. The migrate runner wraps each file in one txn.
-- =====================================================================

ALTER TABLE vibetb.client_contact
  ADD COLUMN IF NOT EXISTS receive_status_notifications boolean NOT NULL DEFAULT true;
