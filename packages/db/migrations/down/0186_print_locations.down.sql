-- Down: 0186_print_locations.sql
ALTER TABLE vibetb.payment_receipt DROP COLUMN IF EXISTS terminal_reader_id;
ALTER TABLE vibetb.terminal_readers
  DROP COLUMN IF EXISTS printer_id,
  DROP COLUMN IF EXISTS auto_print_receipt;
DROP TABLE IF EXISTS vibetb.printer_assignment;
