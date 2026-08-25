ALTER TABLE vibetb.terminal_readers DROP COLUMN IF EXISTS printer_gateway_id;
ALTER TABLE vibetb.notification_template DROP COLUMN IF EXISTS printer_gateway_id;
ALTER TABLE vibetb.signature_print_rule DROP COLUMN IF EXISTS gateway_id;
ALTER TABLE vibetb.app_user DROP COLUMN IF EXISTS default_printer_gateway_id;
ALTER TABLE vibetb.print_log DROP COLUMN IF EXISTS gateway_id;
DROP INDEX IF EXISTS vibetb.printer_assignment_gateway_printer_uk;
ALTER TABLE vibetb.printer_assignment DROP COLUMN IF EXISTS is_office_default;
ALTER TABLE vibetb.printer_assignment DROP COLUMN IF EXISTS gateway_id;
DROP TABLE IF EXISTS vibetb.print_gateway;
