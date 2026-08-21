-- 0221 — bulk-email opt-out per person. Staff can block a person from
-- firm bulk emails on their profile; a portal user with a linked person
-- can toggle it themselves under notification preferences. Targeted
-- transactional mail (invoices, reminders, portal invites) is unaffected.
ALTER TABLE person
  ADD COLUMN IF NOT EXISTS bulk_email_opt_out boolean NOT NULL DEFAULT false;
