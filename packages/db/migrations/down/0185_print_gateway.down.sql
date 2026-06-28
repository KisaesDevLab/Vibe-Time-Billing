-- Down: 0185_print_gateway.sql
DROP TABLE IF EXISTS vibetb.print_log;
ALTER TABLE vibetb.app_user DROP COLUMN IF EXISTS default_printer_id;
ALTER TABLE vibetb.firm_settings
  DROP COLUMN IF EXISTS print_gateway_config_encrypted,
  DROP COLUMN IF EXISTS print_gateway_config_updated_at;
