---
title: 'Set up the calendar connection (admin)'
slug: calendar-oauth-setup
category: admin
audience: staff
tags: ['calendar', 'admin', 'oauth', 'microsoft', 'google', 'setup', 'integration']
---

# Set up the calendar connection

Before staff can link calendars, a calendar provider must be enabled. There are two ways to supply the OAuth app the connection needs.

## Option A — Built-in (appliance) app (recommended)

The operator registers **one** OAuth app per provider and sets its credentials in the appliance environment. After that, **every staff member just signs in** to link their own calendar — there's no per-firm setup and no organization-wide admin consent.

Environment variables:

- `CALENDAR_MS_CLIENT_ID`, `CALENDAR_MS_CLIENT_SECRET`, `CALENDAR_MS_TENANT_ID` (use `common` for work + personal accounts)
- `CALENDAR_GOOGLE_CLIENT_ID`, `CALENDAR_GOOGLE_CLIENT_SECRET`

Register these redirect URIs on the app (replace the host with your app's base URL):

- `https://<your-app-host>/api/calendar/oauth/callback/microsoft`
- `https://<your-app-host>/api/calendar/oauth/callback/google`

Microsoft: register a **multi-tenant** app and request the delegated scopes `Calendars.ReadWrite` and `offline_access` — these are user-consentable, so each staff member approves access for their own mailbox.

When this is configured, **Settings → Calendar integrations** shows a "built-in app active" banner and the per-firm fields below are optional.

## Option B — Your firm's own app

A firm can instead paste its own OAuth app credentials under **Settings → Calendar integrations**: enter the Client ID / Secret (and Tenant ID for Microsoft), use **Test Connection**, then enable the provider. Secrets are encrypted at rest and never shown again.

## Sync schedule

The **Sync schedule** card on **Settings → Calendar integrations** tunes how often and how far the appliance syncs, plus reminder behavior:

- **Interval (min, 5–60)** — how often the sync worker runs.
- **Look back (days)** / **Look ahead (days)** — the window of events that's kept in sync.
- **Appointment reminders** — the reminder offsets to send (7 days before / 3 days before / 1 day before / 2 hours before).
- **Quiet hours** — a **From** / **To** window; SMS & voice reminders only fire inside it (in the firm timezone), while email is always sent.

Click **Save schedule** to apply.

## After enabling

Staff connect from **Account → My Calendars** (see _Connect your calendar_). Monitor connection health under **Settings → Calendar overview**; appointment write-back additionally requires the `FEATURE_CALENDAR_WRITE` flag to be on.
