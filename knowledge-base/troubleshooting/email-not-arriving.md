---
title: 'Emails or codes are not arriving'
slug: email-not-arriving
category: troubleshooting
audience: staff
tags: ['troubleshooting', 'email', 'smtp', 'otp']
---

# Sign-in code or email isn't arriving

You requested a magic link, a sign-in code, or a client notification, and nothing showed up. Because the app is deliberately privacy-preserving about whether an account exists, a "sent" message on screen does not guarantee an email actually went out. Start by confirming what the server actually did.

## Symptoms

- You ask for a magic link / sign-in code and see "If your account exists, a sign-in code has been sent," but no email arrives.
- Password sign-in returns `email_dispatcher_unavailable` or `sms_dispatcher_unavailable` when you pick the email/SMS factor.
- Client-facing notifications (invoices, dunning, receipts) never reach clients.
- Emails work in development but not after deploying the appliance.

## Causes & fixes

1. **Enumeration-safe response is hiding a non-existent account.** The login endpoint always returns the same generic message whether or not the email matches a user. Fix: confirm the address exactly matches the staff/client record (an operator can verify the user exists in Admin).
2. **No real mail provider configured (operator).** The server picks a provider from `MAIL_PROVIDER` (`smtp` / `postmark` / `resend` / `emailit`). For postmark/resend/emailit, if the matching secret is missing the app silently falls back to a console provider that only logs to stdout — nothing is emailed. (`ses` is selectable in the schema but **not yet wired** — don't rely on it.) Fix: set `MAIL_PROVIDER`, `MAIL_FROM`, and the provider's credentials, then restart the API. When configuring email in **Admin → Messaging**, a failed **Save**/**Send test** now reports the exact invalid field (for example "host: Required" or "apiKey: too small") instead of a generic `invalid_email_config`.
3. **You're in dev pointing at MailHog.** The default dev config is SMTP to MailHog (`localhost:1025`, web inbox at `http://localhost:8025`). Mail won't reach real inboxes — check the MailHog UI; for real delivery switch `MAIL_PROVIDER` to a live provider.
4. **The provider accepted it but delivery failed.** Every send appends a `notification_log` row with status `sent` or `failed`. Fix: check **Admin → Notifications → Outbound notifications**. A `failed` row's error points at bad credentials, a rejected `from` address, or throttling; a `sent` row means the problem is downstream (spam folder, recipient server).
5. **SMS code not arriving.** SMS uses `SMS_PROVIDER` (`textlink` / `twilio`), with the same console fallback if credentials are missing (`sns` not wired). The user must also have a verified SMS phone enrolled. Fix: configure the SMS provider and confirm SMS enrollment.

## Tips

- Check spam/junk first — short code emails are often filtered.
- Codes and links are short-lived; request a fresh one rather than reusing an old message.
- The Outbound notifications log is the single source of truth for "did it leave the building."
- Operators: console-fallback sends appear only in the API container logs, never in an inbox — a sign the provider isn't really configured.
