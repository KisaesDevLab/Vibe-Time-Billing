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
ALTER TABLE vibetb.intake_files ADD COLUMN ai_label_status text NOT NULL DEFAULT 'pending';
ALTER TABLE vibetb.intake_files ADD COLUMN ai_label_model text;
ALTER TABLE vibetb.intake_files
  ADD CONSTRAINT intake_files_ai_label_status_ck
  CHECK (ai_label_status IN ('pending', 'labeled', 'failed', 'skipped'));

-- Historical rows (sessions already disposed/rejected) never get labeled.
UPDATE vibetb.intake_files f SET ai_label_status = 'skipped'
  FROM vibetb.intake_sessions s
  WHERE s.id = f.session_id AND s.status <> 'received';
