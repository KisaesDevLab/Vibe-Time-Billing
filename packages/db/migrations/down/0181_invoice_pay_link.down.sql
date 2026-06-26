-- Down: 0181_invoice_pay_link.sql
DROP TABLE IF EXISTS vibetb.invoice_pay_link;
ALTER TABLE vibetb.invoice_reminder_log DROP COLUMN IF EXISTS channel;
