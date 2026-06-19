---
title: 'Register the calendar OAuth app (step by step)'
slug: calendar-oauth-app-registration
category: admin
audience: staff
tags:
  ['calendar', 'oauth', 'microsoft', 'azure', 'entra', 'google', 'setup', 'admin', 'walkthrough']
---

# Register the calendar OAuth app (step by step)

This is the one-time setup that lets staff link their own calendars. You register **one** app per provider; afterward every staff member just signs in (each consents only for their own mailbox — no organization-wide admin consent). Set the resulting credentials in the appliance environment, then restart the API.

Throughout, replace **`<APP_HOST>`** with your app's address (for example `practice.yourfirm.com`). The two redirect URIs you'll register are:

- `https://<APP_HOST>/api/calendar/oauth/callback/microsoft`
- `https://<APP_HOST>/api/calendar/oauth/callback/google`

---

## Microsoft 365 / Outlook

1. Go to the **Microsoft Entra admin center** (entra.microsoft.com) → **Identity → Applications → App registrations** → **New registration**. (The Azure portal's "App registrations" works too.)
2. **Name:** e.g. `Vibe Practice Management — Calendar`.
3. **Supported account types:** choose **"Accounts in any organizational directory (any tenant) and personal Microsoft accounts."** This multi-tenant choice is what lets any staff member sign in without your tenant pre-registering the app.
4. **Redirect URI:** platform **Web**, value `https://<APP_HOST>/api/calendar/oauth/callback/microsoft`.
5. Click **Register**.
6. On the **Overview** page, copy the **Application (client) ID** → this is `CALENDAR_MS_CLIENT_ID`.
7. **Certificates & secrets → Client secrets → New client secret.** Give it a description and expiry, then **copy the secret _Value_ immediately** (it's only shown once) → `CALENDAR_MS_CLIENT_SECRET`. (Note the expiry — you'll rotate it before then.)
8. **API permissions → Add a permission → Microsoft Graph → Delegated permissions.** Add:
   - `Calendars.ReadWrite` (read-only deployments can use `Calendars.Read`)
   - `offline_access`
   - `User.Read`
     These are user-consentable, so no admin consent is required — each staff member approves them at sign-in.
9. Set `CALENDAR_MS_TENANT_ID=common` (accepts work **and** personal accounts).

> If your tenant has disabled user consent for third-party apps, a tenant admin must approve the app once (Entra → Enterprise applications → the app → **Grant admin consent**). That's a Microsoft tenant policy, not an app setting.

---

## Google Calendar

1. Go to the **Google Cloud Console** (console.cloud.google.com) → create or select a **project**.
2. **APIs & Services → Library →** search **Google Calendar API → Enable.**
3. **APIs & Services → OAuth consent screen:**
   - **User type: External**, then fill app name, user-support email, and developer contact email.
   - **Scopes:** add `.../auth/calendar.events` (read-only deployments: `.../auth/calendar.readonly`).
   - While the app is in **Testing**, add each staff email under **Test users** — or **Publish** the app. Publishing with the calendar scope is a "sensitive scope" and may require Google verification for unrestricted use.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID.**
   - **Application type: Web application.**
   - **Authorized redirect URIs:** add `https://<APP_HOST>/api/calendar/oauth/callback/google`.
   - Click **Create**.
5. Copy the **Client ID** → `CALENDAR_GOOGLE_CLIENT_ID` and the **Client secret** → `CALENDAR_GOOGLE_CLIENT_SECRET`.

> Before verification, Google shows an "unverified app" warning and caps usage at 100 users. That's fine for piloting; verify the app for production.

---

## Wire the credentials

Set the values in the appliance environment (`.env` / deployment env):

```
CALENDAR_MS_CLIENT_ID=...
CALENDAR_MS_CLIENT_SECRET=...
CALENDAR_MS_TENANT_ID=common
CALENDAR_GOOGLE_CLIENT_ID=...
CALENDAR_GOOGLE_CLIENT_SECRET=...
```

Restart the API so it picks up the new environment. You only need to set the provider(s) you intend to use.

## Verify

1. Open **Settings → Calendar integrations** — you should see the green **"built-in app active"** banner.
2. Go to **My calendar** (or **Account → My Calendars**) and click **Connect** — you should be redirected to the provider sign-in, then returned as **Connected**.
3. Book a test appointment and confirm the event appears on the connected calendar (write-back requires `FEATURE_CALENDAR_WRITE=true`).

## Rotating or revoking

- Rotate the Microsoft client secret before its expiry: create a new secret, update `CALENDAR_MS_CLIENT_SECRET`, restart, then delete the old secret.
- Revoking the app at the provider invalidates every staff connection; they'll simply reconnect from **My calendar**.
