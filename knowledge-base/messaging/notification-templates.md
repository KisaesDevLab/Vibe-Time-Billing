---
title: 'Notification templates'
slug: notification-templates
category: messaging
audience: staff
tags: ['notifications', 'templates', 'email', 'sms', 'variables']
---

# Notification templates

The app sends automated client and sign-in notifications from per-event templates. You can override the baked-in defaults per event and per channel (email or SMS). Templates are plain text with `{{variable}}` markers — there is no HTML or Markdown editor; you insert variables from a picker and the dispatcher substitutes real values at send time.

## Steps

1. Open the admin **Notification templates** page.
2. Review the event list. Each row shows the event label and, for each supported channel, a status pill: `EMAIL override` / `SMS override` (a custom template exists) or `EMAIL default` / `SMS default` (using the baked-in default).
3. Click **Edit** next to the channel you want to change. The editor opens titled "Edit <kind> · <channel>".
4. For email, fill in **Subject**. For all channels, fill in **Body**.
5. Insert variables from the **Variables** list — click a `{{variable}}` button to append it to the body.
6. Click **Save**. A confirmation reports how many variables were detected ("Saved. Detected N variable(s).").
7. To remove a custom template and fall back to the default, click **Revert to default**.
8. To populate any event/channel pair that has no template yet, click **Seed missing defaults** ("Existing overrides preserved.").

## Fields

- **Subject** — email only; omitted for SMS.
- **Body** — required; the text sent, with `{{variable}}` markers.
- **Variables** — picker buttons. Available names include `client.name`, `client.primaryContact`, `invoice.number`, `invoice.total`, `invoice.due_date`, `invoice.balance`, `firm.displayName`, `firm.supportEmail`, `firm.supportPhone`.

## What you'll see

- Events and their channels: **Invoice sent** (EMAIL), **Invoice overdue** (EMAIL, SMS), **First dunning** (EMAIL, SMS), **Second dunning** (EMAIL, SMS), **Payment received** (EMAIL), **Magic link sign-in** (EMAIL), **SMS OTP** (SMS).
- Variables are detected by scanning the subject and body for `{{ name }}` patterns; the count is recorded in the audit log.
- Unset templates use the firm's baked-in defaults, so notifications still send even before you customize anything.

## Tips

- Variable insertion only: do not paste HTML or Markdown expecting it to render — the body is sent as text with values substituted.
- A channel that an event doesn't support shows no pill or Edit button (e.g. **Invoice sent** has no SMS option).
- Provider configuration (which SMTP/Postmark/Resend/SES service sends email, and TextLink/Twilio/SNS for SMS) is set separately — templates control content, not delivery.
- Reverting deletes the override row entirely; the default immediately takes over.
