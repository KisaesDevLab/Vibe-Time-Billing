# Calendar sync — troubleshooting

Connection status appears on **Account → My Calendars** (per staff) and
**Admin → Calendar overview → Connection health** (all staff).

| Symptom (`sync_error`)                           | Cause                                                                                | Resolution                                                                                                                 |
| ------------------------------------------------ | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `auth_failed`                                    | OAuth token rejected (401/403) — consent revoked, password change, or scope removed. | Staff clicks **Connect** again (re-authorize). The connection is parked (not retried) until then.                          |
| `token_expired`                                  | Access token expired and no usable refresh token (Google didn't return one).         | Re-connect. For Google ensure the consent screen grants offline access (the flow requests `prompt=consent`).               |
| `http_429`                                       | Provider throttling (too many requests).                                             | Transient — the next poll retries. If persistent, raise the sync interval (Admin → Calendar integrations → Sync schedule). |
| `http_5xx`                                       | Provider outage.                                                                     | Transient; auto-retries. After 5 consecutive failures the connection is auto-disabled — re-enable by re-connecting.        |
| Test connection fails (Microsoft)                | Wrong tenant/client/secret, or admin consent not granted.                            | Re-check Tenant/Client ID + secret; grant admin consent (see `calendar-setup-microsoft.md`).                               |
| Test connection fails (Google, `invalid_client`) | Wrong client ID/secret.                                                              | Re-copy from Google Cloud Console.                                                                                         |
| No events appear                                 | No calendar selected to sync, or events outside the lookback/lookahead window.       | Account → My Calendars → tick at least one calendar. Adjust the window in Admin → Calendar integrations.                   |
| Provider option not shown to staff               | Provider not enabled by the firm.                                                    | Admin → Calendar integrations → enable the provider.                                                                       |

## How sync works

- A worker heartbeat (`calendar-sync`, every 5 min) syncs each connection no
  more often than the firm's configured interval (5–60 min).
- Events are matched to clients automatically (exact attendee email, then
  fuzzy name). Low-confidence matches land in the **Unmatched** review queue
  (nav badge + `/calendar/unmatched`).
- Reminders (`calendar-reminders`) and post-meeting time suggestions
  (`calendar-time-suggestion`) run on their own 5-min schedules.

## Quick checks

- **Sync now** (Account → My Calendars) forces an immediate sync (rate
  limited to once per 60s).
- Confirm the worker container is running (the jobs only run there).
- Confirm `MAIL_PROVIDER` is configured if reminders aren't being delivered.
