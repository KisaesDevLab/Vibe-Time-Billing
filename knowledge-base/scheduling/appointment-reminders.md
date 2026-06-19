---
title: 'Appointment reminders (email, SMS, voice)'
slug: appointment-reminders
category: scheduling
audience: staff
tags: ['reminders', 'sms', 'voice', 'email', 'appointments', 'confirm', 'twilio', 'quiet hours']
---

# Appointment reminders

Reminders go out before an appointment on the channels you choose — **email, SMS, and automated phone call** — and clients can confirm right from the reminder.

## How a schedule works

A reminder schedule is a list of steps, each with a **time before the appointment** and a **channel**. For example: 1 day before by email, 2 hours before by SMS, 1 hour before by phone call.

Schedules resolve in this order (most specific wins):

1. **This booking's** schedule (set in the booking wizard),
2. otherwise the **appointment type's** default schedule,
3. otherwise the firm's default email offsets (**Settings → Calendar integrations**).

## Set a type's default schedule

**Settings → Appointment types → Set reminders** on a row. Add steps (when + channel) and save. New bookings of that type pre-fill these.

## Override or add for one booking

In the **Book** wizard, **Step 3 (Client & details)** has a **Reminders** section pre-filled from the chosen type. Edit times/channels, add steps, or remove them — what you leave there is what that booking uses.

## Channels & opt-in

- **Email** always sends to opted-in participants.
- **SMS** and **phone call** also require a phone number on the contact.
- A contact's **Receive appointment reminders** toggle turns off all channels for them.
- Templates per channel live in **Settings → Notification templates** (`Appointment reminder` → Email / SMS / Voice script). SMS is concise; the voice script is read aloud by text-to-speech.

## Quiet hours

SMS and voice reminders only fire inside the firm's **quiet-hours window** (**Settings → Calendar integrations**, evaluated in the firm timezone). A step that comes due outside the window waits until the window opens. **Email ignores quiet hours.**

## Two-way confirmation

- **SMS:** the client replies **YES** to confirm; their status flips to **Confirmed** on the appointment.
- **Phone call:** the client **presses 1** to confirm.
  Confirmations appear as the Confirmed/Awaiting chips in the appointments list and detail.

## Setup notes (admin)

- Voice + SMS use Twilio — set `SMS_TWILIO_*` and `VOICE_TWILIO_*` (the voice FROM must be a voice-capable number). Without them, those channels are skipped and email still works.
- For inbound SMS confirmation, set your Twilio number's **Messaging webhook** to `https://<your-app-host>/api/public/appointments/twilio/sms`. Voice press-1 needs no extra setup.
- US senders: reliable application-to-person SMS requires **A2P 10DLC** brand/campaign registration with your carrier, and outbound voice should use a verified caller ID.
