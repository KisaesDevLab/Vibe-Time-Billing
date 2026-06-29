-- Down: 0188_notification_print.sql
ALTER TABLE vibetb.notification_template
  DROP COLUMN IF EXISTS printer_mode,
  DROP COLUMN IF EXISTS printer_id;
