<!-- SPDX-License-Identifier: PolyForm-Small-Business-1.0.0 -->

# Desktop shell build plan (`apps/desktop`)

Status: **built (uncompiled), 2026-08-22** — branch `feat/desktop-shell-v0.2`.
Everything below is implemented in code; the Rust side still needs its first
compile on a Windows box (see `apps/desktop/README.md` → First-compile
checklist). Items marked ⏸ were deliberately left out and are listed at the
end.

## Where we are

`apps/desktop` is a Tauri 2 shell around `@vibe/web` with exactly two native
commands (`list_capturable_windows`, `capture_window`) backing the Capture
Client Info flow. It has **never been compiled**: no Rust toolchain on the
appliance, no icon set, `xcap` pin unverified, CSP `null`. The web side
(`apps/web/src/lib/desktop.ts`, `CaptureClientInfo.tsx`, wizard autofill) is
merged and works via the browser upload fallback.

Relevant existing pieces the plan builds on:

| Area                | What exists                                                                                                                                                                    | Where                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| Timers              | Server-backed multi-timer: list/create, `pause`, `resume`, `save` (creates time entry, deletes timer). Web `TimerProvider` + "Finish on Time page" handoff (`/time?timerId=`). | `apps/api/src/time-entries/timers.ts`, `apps/web/src/timer-context.tsx` |
| Messages            | Internal + client threads; page polls every 30 s.                                                                                                                              | `apps/web/src/pages/Messages.tsx`, `pages/messaging/*`                  |
| Intake              | Intake inbox page, send-intake-link dialog, OCR client-intake endpoint.                                                                                                        | `pages/IntakeInbox.tsx`, `apps/api/src/ocr/*`                           |
| Requests            | Doc requests list/detail; portal upload is base64, 20 MB cap.                                                                                                                  | `pages/Requests.tsx`, `apps/api/src/portal/requests.ts`                 |
| Notification center | In-app list, `/unread-count`, read/dismiss/read-all. No push/SSE to staff.                                                                                                     | `apps/api/src/notifications/center-routes.ts`                           |
| Auth                | Cookie session, Redis store, TOTP/WebAuthn step-up.                                                                                                                            | `apps/api/src/auth/*`                                                   |

Design principles for everything below:

1. **Browser parity stays intact.** Every feature is gated on `isDesktop()`;
   the SPA must keep working unchanged in a tab.
2. **No build-time Tauri dependency in `@vibe/web`.** Keep calling through
   `window.__TAURI__` from `lib/desktop.ts` so web CI never needs Rust.
3. **One event pipe, many consumers.** Messages, intake, requests, alerts and
   approvals all ride one server→client stream and one native notifier.
4. **PII stays on the workstation.** Captures in memory only; notifications
   carry titles/ids, never document contents or tax IDs.

---

## Milestone 0 — First compile (prerequisite for everything)

Goal: `tauri dev` and `tauri build` succeed on the firm's Windows workstation.

- [ ] Install Rust (stable), MSVC build tools, WebView2 on the build box. ⏸ (needs the Windows workstation)
- [x] Generate icons (from `apps/portal/public/icon-512.png`; re-run with the firm logo to rebrand).
- [ ] Compile; fix `xcap 0.3` accessor drift ⏸ (needs the Windows workstation) — in `lib.rs` (return types of
      `id()/title()/width()` etc. changed across 0.x — expect small edits).
- [x] Replace `"csp": null` with a real policy: `default-src 'self'; connect-src
  'self' http://localhost:3001 https://<appliance>; img-src 'self' data:
  blob:; style-src 'self' 'unsafe-inline'`. Tighten once plugins land.
- [x] Split `capabilities/default.json` per window (`main`, later `timer`) and
      list only the commands each needs.
- [ ] Validate live capture against a real UltraTax window ⏸ (firm hardware); document the
      black-frame behavior under RDP/Citrix.
- [x] Add a GitHub Actions `desktop-build.yml` on `windows-latest` (manual
      dispatch + tags only) that runs `tauri build` and uploads the NSIS/MSI
      artifact. Web CI remains Rust-free.

Exit: signed-or-unsigned installer runs on one staff machine; Capture Client
Info works end to end natively.

---

## Milestone 1 — Timer (tray, hotkey, idle, mini widget)

Goal: the app is worth leaving open all day.

### 1.1 System tray

- Rust: `tauri::tray::TrayIconBuilder` with menu: _Start timer…_, per-timer
  _Switch to <client>_ entries, _Pause/Resume current_, _Finish on Time page_,
  separator, _Open Vibe_, _Quit_. Tooltip = `"<client> · 01:23:45"`.
- Web→native: `TimerProvider` already owns the timer list. Add
  `desktop.syncTray(timers, activeId)` in `lib/desktop.ts` that invokes a
  `set_tray_state` command whenever timers change; Rust rebuilds the menu and
  updates the tooltip on a 1 s tick using the `started_at` it was handed (no
  per-second IPC).
- Native→web: tray menu clicks `emit("tray:action", {kind, timerId})`; the
  provider listens via `window.__TAURI__.event.listen` and calls the existing
  start/pause/resume/finish functions.
- Close-to-tray: intercept `CloseRequested` on `main`, hide instead; _Quit_
  exits. Setting in Account → Desktop: "Close button minimizes to tray".

### 1.2 Global hotkeys

- `tauri-plugin-global-shortcut`. Defaults: `Ctrl+Shift+T` toggle
  pause/resume on the active timer, `Ctrl+Shift+N` open "Start timer" with
  the window focused. User-remappable in Account → Desktop; persisted with
  `tauri-plugin-store`.
- Hotkey emits the same `tray:action` events as 1.1.

### 1.3 Idle detection

- Rust: `user-idle` crate polled every 30 s; when idle ≥ threshold (default
  10 min, configurable) and a timer is running, record `idle_since`. On
  activity resume, emit `timer:idle-return {idleSeconds, timerId}`.
- Web: modal "You were away 18 min — Keep time / Discard idle / Stop at
  idle start". "Discard" calls a new API: `POST /timers/:id/trim
{seconds}` which subtracts from accumulated elapsed (server-side, audited).
  "Stop at idle start" = trim + pause.
- API change: `timers.ts` gains `trim`; add test in `time-timer.test.ts`.

### 1.4 Always-on-top mini widget

- Second Tauri window `label: "timer"`, 280×64, `decorations: false`,
  `alwaysOnTop: true`, `skipTaskbar: true`, position remembered in store.
- Loads the same SPA at route `/desktop/timer` (new tiny page rendering
  active timer, pause/resume, and a switch dropdown). It gets its own
  capability file with only timer-related commands.
- Toggle from tray and hotkey `Ctrl+Shift+W`.

### 1.5 Foreground-window timer suggestion (opt-in)

- Rust: poll the foreground window title every 5 s (`xcap`/Win32
  `GetForegroundWindow`). If it matches UltraTax and the title contains a
  client id, emit `desktop:foreground-client {externalId}`. Never captures
  pixels.
- Web: if no timer is running for a client whose `external_id` matches,
  show a dismissible toast "Start timer for Smith, John?". Snooze per client
  for the day. Off by default; toggle in Account → Desktop.
- Reuses the Client ID = `clients.external_id` mapping (no new field).

Exit: a staff member can run the whole day from the tray/widget without
opening the main window.

---

## Milestone 2 — Notification center + deep links

Goal: one pipe that Messages, Intake, Requests, Alerts and Approvals plug into.

### 2.1 Server push (SSE)

- New `GET /api/staff/events` (SSE, cookie-auth, per-user). Emits
  `notification` events sourced from the existing notification-center
  writes (hook the insert path in `notifications/*` so anything that lands
  in the in-app center is also pushed). Heartbeat every 25 s; Redis pub/sub
  fan-out so it works across API replicas.
- Payload: `{id, category, title, body, href, createdAt}`. `category ∈
message | intake | request | alert | approval | appointment`. `body` is
  a short summary — no document contents.
- Web: `useStaffEvents()` hook with reconnect/backoff. Messages page drops
  its 30 s poll in favour of the stream (keeps poll as fallback when the
  stream is down). Browser users also benefit (in-app toast + unread badge).

### 2.2 Native notifier

- `tauri-plugin-notification`. Web forwards each event to
  `desktop.notify(event)` only when the main window is not focused.
- Windows toast actions: _Open_, and for `message` an inline reply box that
  POSTs to the existing thread reply endpoint; for `intake` _Assign to me_.
- Per-category mute + quiet hours in Account → Desktop (stored in
  `tauri-plugin-store`, mirrored to the server so the in-app center honours
  it too).
- Unread badge: `window.set_badge_count` (Tauri 2.x, Windows overlay icon)
  driven by `/unread-count`, refreshed on each event.

### 2.3 Deep links

- `tauri-plugin-deep-link`, scheme `vibetb://`. Map `vibetb://<path>` →
  SPA route `/<path>` (e.g. `vibetb://requests/123`). Registered at install
  (NSIS) and on first run.
- `tauri-plugin-single-instance` so a second launch forwards its URL to the
  running instance instead of opening a new window.
- Server: add `desktop_url` alongside `url` in notification emails so
  staff with the app installed land in it. (Feature-flag per firm.)

Exit: new message → toast within ~1 s → click → correct thread in the app.

---

## Milestone 3 — Rollout hygiene

Goal: safe to install on every staff machine.

### 3.1 Auto-update

- `tauri-plugin-updater` with static JSON manifest served from the
  appliance at `/desktop/latest.json` (behind staff auth is fine — updater
  supports custom headers; or public with only version + signature).
- Signing key generated once (`tauri signer generate`), private key in the
  appliance secrets store; CI signs on tag builds. Check on launch + every
  6 h; prompt "Restart to update".

### 3.2 Start at login, single instance, minimize-to-tray

- `tauri-plugin-autostart` (toggle in Account → Desktop, default on).
- Single instance from 2.3.
- Start hidden in tray when launched at login.

### 3.3 Session persistence

- Keep cookie sessions as the auth model (no token exposure). WebView2
  persists cookies per-user profile, so normal logins already survive
  restarts up to the server session TTL.
- Add a **desktop-scoped long session**: on login from the shell, the API
  issues a longer-lived refresh credential bound to a device id; store it
  via `keyring` (Windows Credential Manager) and present it on startup to
  mint a fresh cookie session. Step-up (TOTP/WebAuthn) still applies to
  sensitive actions. Audit `LOGIN` with `source: desktop`.
- Remote revoke: Admin → Users shows desktop devices; revoke deletes the
  refresh credential server-side.

### 3.4 Security checklist before first firm-wide install

- CSP finalised; `withGlobalTauri` kept but capabilities minimal per window.
- Every command validates inputs; `capture_window` only callable from
  `main`.
- No secrets in `tauri.conf.json`; updater pubkey only.
- Installer signed (Authenticode) if the firm has a cert; otherwise document
  SmartScreen bypass for IT.

Exit: unattended updates work; reinstall not needed for fixes.

---

## Milestone 4 — Files and windows

### 4.1 Drag-and-drop uploads

- Tauri window `dragDropEnabled: true`; listen for `tauri://drag-drop` in
  the Intake Inbox, client Files tab, and Request detail pages. Native paths
  are read in Rust (`read_file_chunk` command) and streamed to a new
  multipart upload endpoint — bypassing the 20 MB base64 portal path.
- API: `POST /api/staff/clients/:id/files/upload` (multipart, streaming to
  B2 via `packages/storage`), honours the `Client Files/` prefix and the
  `client_subfolders` registry; same for request uploads. Reuse existing
  file-create logic so `storage_key` stays mirrored.
- Batch progress UI; per-file errors don't abort the batch.

### 4.2 Open natively

- `tauri-plugin-opener`: "Open" on any file/request upload downloads to a
  temp dir scoped to the app (`%LOCALAPPDATA%\VibeTB\cache`), opens with the
  default app, and purges the cache on quit and after 24 h.

### 4.3 Print-to-PDF helper

- "Attach from UltraTax": instruct user to print to the
  _Microsoft Print to PDF_ printer into a watched folder
  (`%USERPROFILE%\VibeTB\Outbox`); Rust `notify` watcher picks up the new
  PDF, prompts "Attach to <request/client>?", uploads via 4.1, deletes the
  file. Also feeds the existing OCR PDF fallback in Capture Client Info.

### 4.4 Capture Client Info everywhere

- Surface the existing capture modal from the Intake Inbox and Client
  Detail (not only Create Client). No new native code.

---

## Milestone 5 — Later

- **Appointment reminders**: `appointment` category on the 2.1 stream; 15
  min before, native toast with _Join/Open_.
- **Offline time-entry queue**: `tauri-plugin-store` queue of timer
  actions and time entries while the API is unreachable; replay on
  reconnect with idempotency keys (timer endpoints already need `trim` and
  should accept `Idempotency-Key`).

---

## Cross-cutting work items

| Item                                                                                                                                    | Scope       |
| --------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| `lib/desktop.ts` grows into a typed facade (`desktop.tray`, `.notify`, `.events`, `.files`)                                             | web         |
| Account → **Desktop** settings tab (tray, hotkeys, idle threshold, notifications, autostart, foreground suggestions)                    | web + store |
| `apps/api` additions: `/staff/events` SSE, `timers/:id/trim`, multipart uploads, desktop refresh credential, notification `desktop_url` | api         |
| Tests: Rust unit tests for command input validation; API tests for trim/SSE/multipart; Playwright smoke with `__TAURI__` stubbed        | all         |
| Docs: update `apps/desktop/README.md` per milestone; IT install guide under `docs/ops/desktop-install.md`                               | docs        |

## Sequencing and rough effort

| Milestone                    | Depends on                    | Effort (one dev) |
| ---------------------------- | ----------------------------- | ---------------- |
| 0 First compile              | Windows box                   | 2–3 days         |
| 1 Timer                      | 0                             | 1.5–2 weeks      |
| 2 Notifications + deep links | 0 (SSE can start in parallel) | 1.5 weeks        |
| 3 Rollout hygiene            | 0, 2.3                        | 1 week           |
| 4 Files                      | 0                             | 1.5 weeks        |
| 5 Later                      | 2                             | as scheduled     |

Recommended order: **0 → 1.1–1.3 → 2.1–2.2 → 3.1 (updater) → ship v0.2
to one or two staff → 1.4/1.5, 2.3, 3.2–3.4 → v0.3 firm-wide → 4 → 5.**
Getting the updater in before the first real install avoids manual
reinstalls for everything that follows.

## Risks

- **xcap black frames under RDP/Citrix** — mitigated by the PDF fallback
  and 4.3; confirm on the actual firm setup in Milestone 0.
- **Windows Credential Manager / keyring behaviour on roaming profiles** —
  test 3.3 on a domain-joined machine early.
- **WebView2 cookie persistence vs. server session TTL** — decide TTL policy
  with the firm before 3.3.
- **Multi-replica SSE** — requires Redis pub/sub; single-appliance today so
  low risk, but build it that way from the start.

---

## Build log (2026-08-22)

Implemented on `feat/desktop-shell-v0.2` in three commits (API, web, shell):

- **API**: `GET /api/staff/events` SSE (counts + notifications + appointment
  reminders, Redis pokes from write paths, id-based dedupe), `POST
/timers/:id/trim`, desktop device credentials (`/api/auth/desktop/enroll|
refresh`, `/api/staff/desktop/devices`), release channel
  (`/desktop/latest.json`, `/desktop/dl/:file`). Tests: `staff-events`,
  `desktop-devices`, `desktop-releases`, trim cases in `time-timer`.
- **Web**: `lib/desktop.ts` contract, `lib/staff-events.ts`,
  `lib/desktop-settings.ts`, `lib/desktop-session.ts`,
  `components/DesktopShellBridge.tsx` + `StaffToasts` + `OutboxAttachDialog`,
  `timer/DesktopTimerBridge.tsx`, `pages/desktop/TimerWidget.tsx`,
  `pages/account/DesktopSettingsCard.tsx`; Messages/InternalMessages react to
  stream events; native open in Files; drop-to-fulfil on request items;
  Capture Client Info from Intake Inbox.
- **Shell**: `src-tauri/src/{capture,tray,windows,hotkeys,watchers,notify,
secrets,rollout,files,state,lib}.rs`, `tauri.conf.json` (CSP, deep-link,
  updater, NSIS/MSI), per-window capabilities, icons, `desktop-build.yml`.

### Deliberately not done (⏸) and why

- **Compile / run on Windows** — no toolchain here; first-compile checklist in
  the README.
- **`desktop_url` in notification emails (2.3)** — staff URLs are built in
  many mailers; adding a second link everywhere is a separate pass once the
  scheme is registered on real machines.
- **Capture Client Info from Client Detail (4.4)** — applying a capture to an
  _existing_ client means overwriting fields; that needs a product decision
  (merge UI vs. overwrite) before it is worth building. Intake Inbox entry
  point is done.
- **Admin UI for device revoke (3.3)** — endpoint exists
  (`DELETE /api/staff/desktop/devices/user/:appUserId`); no Admin → Users
  button yet.
- **Code signing certificate** — config supports it; the firm has to buy one.
- **Multipart upload endpoint (4.1)** — unnecessary: staff uploads already
  use presigned PUTs with no 20 MB cap (that cap is portal-only). Drag-drop
  uses the existing path; Tauri's native drop handler is disabled so HTML5
  drop keeps working.
