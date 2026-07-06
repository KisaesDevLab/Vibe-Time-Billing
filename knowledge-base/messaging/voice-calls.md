---
title: 'Automated voice calls'
slug: voice-calls
category: messaging
audience: staff
tags: ['voice', 'twilio', 'appointments', 'notifications', 'call']
---

# Automated voice calls

The appliance can place automated phone calls for **appointment reminders** and **engagement status notifications**, using a Twilio account dedicated to voice (separate from the SMS account). Calls speak a template-driven script in a voice you choose, let the client **press 1 to confirm** an appointment or **press 9 to stop automated calls**, leave the message on voicemail, and automatically fall back to a text message when the call can't connect.

## Setup

1. Go to **Admin → Messaging** and find the **Voice calls (Twilio)** card.
2. Enter the voice account's **Account SID**, **Auth token**, and a voice-capable **From number** (E.164, e.g. `+12025551212`). Credentials are encrypted at rest and never shown again — only masked previews.
3. Pick the **Default voice** (Amazon Polly voices like `Polly.Joanna` or `Polly.Matthew`) and **Language** (e.g. `en-US`).
4. Set the **Calling window** — automated calls only place between these firm-local times (default 9:00 AM – 8:00 PM). Calls that come due outside the window wait for it to open; the SMS fallback is not window-restricted.
5. Enter your own number in **Test call number** and click **Test call** to hear the configured voice before saving.

## Where calls come from

- **Appointment reminders** — add a CALL step to a reminder schedule (per appointment, appointment type, or firm default). The spoken script is the `appointment_reminder` CALL template; the call offers "press 1 to confirm," which flips the participant's RSVP.
- **Engagement status notifications** — tick **Voice call** under Methods in the status editor (Admin → Engagement statuses). The script is that status's CALL template; approvals and staging work exactly like the other channels.

## Scripts, variables, and per-template voices

Edit CALL scripts under **Admin → Notification templates**. Scripts support the same `{{ variable }}` insertion as email/SMS (e.g. `{{ client.name }}`, `{{ appointment.date }}`, `{{ appointment.time }}`, `{{ firm.name }}`, `{{ status.client_label }}`) — write for the ear: short sentences, no URLs or abbreviations. Each CALL template can also override the firm's default **voice**, so reminders and dunning-style notices can sound different.

## Client replies

Responses land on the client's **Communications timeline** (client page → Communications) as inbound entries: any text message a known contact sends to the SMS number (not just "YES" confirmations), a press-1 appointment confirmation, and a press-9 opt-out. Configure the Twilio SMS number's _"A message comes in"_ webhook to `https://<your app domain>/api/public/appointments/twilio/sms` for inbound texts; the voice webhooks are wired automatically per call.

## Opt-out and outcomes

- Every call announces "press 9 to stop automated calls." Pressing 9 sets a **Do not call** flag on the person — visible and editable on the client's People card — and future notifications reach them by text instead.
- Call outcomes (answered, voicemail, busy, no answer, failed, opted out) are logged per call; busy/no-answer/failed calls automatically send the SMS version of the message.
- Contacts opted out of appointment reminders or status notifications entirely are never called.

## Tips

- The from number must be **voice-capable** in Twilio (SMS-only numbers fail with `twilio_voice_400`).
- Voicemail detection means the message is left on the machine — that counts as delivered, so no SMS fallback fires for voicemail.
- If nothing is configured in Admin, the appliance falls back to the `VOICE_TWILIO_*` environment variables; with neither present, CALL steps are skipped silently.

Related: [[notification-templates]], [[staged-notifications]], [[engagement-status-notifications]]
