# Calendar setup — Google Calendar

Create a Google Cloud OAuth client so staff can connect their Google
calendars. Done once per firm by an admin.

## 1. Project + API

1. <https://console.cloud.google.com> → create (or pick) a project.
2. **APIs & Services** → **Library** → enable **Google Calendar API**.

## 2. OAuth consent screen

1. **APIs & Services** → **OAuth consent screen**.
2. User type **Internal** (Workspace) or **External**.
3. Add the scope `https://www.googleapis.com/auth/calendar.readonly`.
4. (External) add your staff as test users until the app is verified.

## 3. OAuth client

1. **Credentials** → **Create credentials** → **OAuth client ID**.
2. Application type: **Web application**.
3. **Authorized redirect URI:**
   `https://<your-staff-domain>/api/calendar/oauth/callback/google`
   (the exact URI is shown on the Admin → Calendar integrations card).
4. Create → copy the **Client ID** and **Client secret**.

## 4. Enter into Vibe

Admin → **Calendar integrations** → Google Calendar:

- **Client ID** and **Client Secret** from step 3.

Click **Test connection** (probes Google's token endpoint — `invalid_client`
means the credentials are wrong), then **Save** and toggle **Enabled**.
Staff connect from **Account → My Calendars**.

Notes:

- Google only returns a **refresh token** on the first consent; the connect
  flow requests `access_type=offline&prompt=consent` to ensure one.
- See `calendar-sync-troubleshooting.md` for common errors.
