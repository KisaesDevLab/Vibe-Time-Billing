-- =====================================================================
-- Migration: 0230_intake_ai_label.sql
--
-- Intake-arrival AI labeling. After ClamAV + PDF combine, an API-side
-- consumer labels each clean intake file (doc type / tax year / issuer /
-- suggested name) so staff see what a document is BEFORE dispositioning;
-- dispose rebuilds the final filename from the stored label with no
-- second model call. Labels are stored plaintext — they are PII-free by
-- model contract + stripPiiFields; the original filename stays
-- MFK-encrypted as before. ai_period / ai_doc_date are kept so patterns
-- using {period}/{date} rebuild exactly the name that was suggested.
--
-- NOTE: no `DO $$ ... $$` blocks (the pglite test harness strips them);
-- bare statements only. Migrate runner wraps each file in one txn.
-- =====================================================================

ALTER TABLE vibetb.intake_files ADD COLUMN ai_doc_type text;
ALTER TABLE vibetb.intake_files ADD COLUMN ai_tax_year smallint;
ALTER TABLE vibetb.intake_files ADD COLUMN ai_issuer text;
ALTER TABLE vibetb.intake_files ADD COLUMN ai_period text;
ALTER TABLE vibetb.intake_files ADD COLUMN ai_doc_date text;
ALTER TABLE vibetb.intake_files ADD COLUMN ai_suggested_name text;
ALTER TABLE vibetb.intake_files ADD COLUMN ai_confidence real;
-- Default is 'skipped', NOT 'pending' (review finding): 'pending' means "a
-- label job exists for this row" and is set by the worker in the same step
-- that enqueues the job. With a 'pending' default, every path where the
-- enqueue never lands (old worker beside a new DB, Redis down at enqueue,
-- consumer disabled) would strand rows on a permanent "AI labeling…"
-- badge; with 'skipped', a missed enqueue simply shows no label. This also
-- makes a backfill unnecessary — pre-existing rows are 'skipped'.
ALTER TABLE vibetb.intake_files ADD COLUMN ai_label_status text NOT NULL DEFAULT 'skipped';
ALTER TABLE vibetb.intake_files ADD COLUMN ai_label_model text;
ALTER TABLE vibetb.intake_files
  ADD CONSTRAINT intake_files_ai_label_status_ck
  CHECK (ai_label_status IN ('pending', 'labeled', 'failed', 'skipped'));
