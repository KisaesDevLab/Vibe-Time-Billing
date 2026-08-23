-- 0224 — SMS opt-out per person, the SMS counterpart of bulk_email_opt_out
-- (0221) and do_not_call (0206). Staff set it on the person profile; a
-- portal user with a linked person can set it under notification
-- preferences. Security codes (OTP) and staff-requested portal invites are
-- unaffected; reminders, status notifications, dunning and invoice texts are.
ALTER TABLE vibetb.person
  ADD COLUMN IF NOT EXISTS sms_opt_out boolean NOT NULL DEFAULT false;
