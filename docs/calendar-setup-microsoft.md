# Calendar setup — Microsoft 365 / Outlook

Register an Azure AD app so staff can connect their Outlook calendars. Done
once per firm by an admin.

## 1. Create the app registration

1. Go to <https://portal.azure.com> → **Microsoft Entra ID** → **App
   registrations** → **New registration**.
2. Name: e.g. `Vibe Calendar`.
3. **Supported account types:** "Accounts in this organizational directory
   only" (single tenant) is typical for a firm.
4. **Redirect URI:** platform **Web**, value:
   `https://<your-staff-domain>/api/calendar/oauth/callback/microsoft`
   (the exact URI is shown on the Admin → Calendar integrations card).
5. Register.

## 2. Add Calendar permissions

1. **API permissions** → **Add a permission** → **Microsoft Graph** →
   **Delegated permissions**.
2. Add: `Calendars.Read`, `offline_access`, `User.Read`.
   (For the future write-back release: `Calendars.ReadWrite`.)
3. **Grant admin consent** for the directory.

## 3. Create a client secret

1. **Certificates & secrets** → **New client secret** → copy the **Value**
   immediately (it's only shown once).

## 4. Enter into Vibe

Admin → **Calendar integrations** → Microsoft 365:

- **Tenant ID** — from the app's Overview page (Directory/tenant ID).
- **Client ID** — Application (client) ID.
- **Client Secret** — the secret value from step 3.

Click **Test connection** (a client-credentials grant; must succeed), then
**Save** and toggle **Enabled**. Staff can now connect from
**Account → My Calendars**.

See `calendar-sync-troubleshooting.md` if Test connection fails.
