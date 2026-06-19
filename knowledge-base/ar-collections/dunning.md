---
title: 'Dunning reminders'
slug: dunning
category: ar-collections
audience: staff
tags: ['dunning', 'reminders', 'overdue', 'collections']
---

# Collections & dunning reminders

Dunning is the automated past-due follow-up that runs in the background. An hourly worker sweep scans invoices that are `SENT`, `PARTIALLY_PAID`, or `OVERDUE` with a due date on or before today, and fires the reminder steps that haven't yet been sent for each invoice. Steps escalate as an invoice ages, and the system records every attempt.

## Steps

1. Let the schedule run automatically — the `dunning-sweep` job runs hourly. No per-invoice setup is required.
2. Customize the wording under **Admin → Firm settings** in the **Dunning messages** section, with five fields: **1 Period old**, **2 Periods old**, **3 Periods old**, **4 Periods old**, **5 Periods or older**.
3. To send a one-off reminder now, open **Invoices**, find the invoice, and click **Remind** (available unless the invoice is `DRAFT`, `PAID`, or `VOIDED`). It emails the client's billing contact.
4. Respect the cooldown: if a reminder went out in the last 24 hours, the **Remind** button is disabled and its tooltip shows how long ago the last one was sent.
5. Review history per invoice via the dunning-history record (each step's kind, channel, recipient, and outcome).
6. Audit all outbound dunning under **Admin → Notifications** (**Outbound notifications**), filterable by **Window**; failures keep their error text.
7. Trigger a manual sweep for testing under **Admin → Jobs** — click **Run now** next to `dunning-sweep`.

## Fields

- **Remind** — sends an immediate friendly reminder email for that invoice.
- **Dunning messages 1-5** — per-period message text in firm settings.
- **Window** — time range filter on the outbound notifications log.
- **Run now** — enqueues a one-off run of a scheduled job.

## What you'll see

- The default cadence fires by days overdue: day 7 `REMINDER_FRIENDLY` ("Friendly reminder: invoice past due"), day 21 `REMINDER_FIRM` ("Past due notice"), day 45 `REMINDER_ESCALATED` ("Urgent: invoice significantly past due"), day 60 `PARTNER_NOTIFY` ("Past due — partner escalation"), day 90 `AUTO_PAUSE` ("Service pause notice").
- Channel is email when the billing contact has an email; otherwise SMS if a billing phone exists; otherwise the step is logged but not delivered.
- At day 60 the engagement's partner-in-charge also gets an escalation email.
- At day 90 the primary engagement is automatically set to `PAUSED` (no new time entries) and the change is audit-logged.
- Each step is recorded once per invoice (a step never double-fires), and an invoice still in `SENT` flips to `OVERDUE` once a step fires.
- Every send is also written to the client's communication timeline as an `OUTBOUND` `dunning` entry.

## Tips

- Automatic and manual reminders share the same 24-hour cooldown, so a manual **Remind** won't stack on top of a recent automated step.
- To stop the cycle for a client, resolve the balance — paying, marking paid, or voiding removes the invoice from the sweep. There is no per-client "pause dunning" toggle.
- The sweep processes up to 500 overdue invoices per run.
- Email/SMS only deliver when the firm has configured a provider; otherwise steps are recorded as not dispatched.
