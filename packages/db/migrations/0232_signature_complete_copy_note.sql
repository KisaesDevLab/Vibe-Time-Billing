-- =====================================================================
-- Migration: 0232_signature_complete_copy_note.sql
--
-- The signature-completion confirmation told the client "A copy is
-- available for your records." and then said nothing about how to get
-- one. The send site now resolves {{ document.copy_note }} to either
-- "Your signed copy is attached to this email." (the signed PDF is
-- enclosed) or a concrete "contact <firm> at <support email/phone>".
--
-- The template seeder is ON CONFLICT DO NOTHING, so firms seeded before
-- this keep the old sentence. Rewrite just that sentence, and only where
-- it still appears verbatim — a firm that reworded the paragraph is left
-- entirely alone.
--
-- NOTE: no `DO $$ ... $$` blocks (the pglite test harness strips them);
-- bare statements only. Migrate runner wraps each file in one txn.
-- =====================================================================

UPDATE vibetb.notification_template
   SET body = replace(body, 'A copy is available for your records.', '{{ document.copy_note }}')
 WHERE kind = 'signature_complete'
   AND channel = 'EMAIL'
   AND body LIKE '%A copy is available for your records.%';
