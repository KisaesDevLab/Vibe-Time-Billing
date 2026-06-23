-- Down migration for 0180_backup_scheduling.sql
DROP TABLE IF EXISTS vibetb.backup_run;
DROP TABLE IF EXISTS vibetb.backup_config;
