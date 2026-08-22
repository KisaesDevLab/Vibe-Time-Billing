<!-- SPDX-License-Identifier: PolyForm-Small-Business-1.0.0 -->

# Vibe desktop app — install guide (IT)

## What it is

A small Windows app (`Vibe Time & Billing`) that wraps the staff web app and
adds a tray timer, notifications, UltraTax screen capture and file helpers.
It talks only to the firm's Vibe appliance (same URLs as the browser) and,
for file uploads/downloads, to the firm's Backblaze bucket. Nothing goes to
Kisaes.

## Appliance side (once)

1. Set `DESKTOP_RELEASES_DIR=/srv/vibe/desktop-releases` (any path the API
   container can read) and restart the API.
2. Copy the contents of the `vibe-desktop-windows` build artifact into that
   folder: `latest.json`, `Vibe Time & Billing_X.Y.Z_x64-setup.exe`, and its
   `.sig`.
3. Confirm `https://<appliance>/desktop/latest.json` returns the manifest.

## Workstation side

1. Run the `-setup.exe` once (per-user install, no admin rights needed).
   SmartScreen may warn until the installer is code-signed; choose _More
   info → Run anyway_.
2. Launch Vibe, sign in as usual (second factor included). Tick _Keep me
   signed in on this computer_ in **Account → Desktop** if the workstation
   is single-user; leave it off on shared machines.
3. Optional per-user settings in **Account → Desktop**: start at login,
   close-to-tray, hotkeys, idle threshold, notification categories, quiet
   hours, UltraTax timer suggestions, print-to-PDF outbox.

Updates are automatic from then on (checked at launch and every 6 hours;
the user clicks _Restart to update_).

## Print-to-PDF from UltraTax

Print to **Microsoft Print to PDF** and save into
`C:\Users\<user>\VibeTB\Outbox`. Vibe pops up _Attach printed PDF_; after
the upload the file is deleted from the folder.

## Revoking a remembered device

- User: **Account → Desktop → Remembered devices → Revoke**, or simply sign
  out (sign-out forgets the device).
- Admin: `DELETE /api/staff/desktop/devices/user/<appUserId>` (requires
  `app_user:write`) — an Admin UI button can wrap this; archiving the user
  also invalidates every device.

## Uninstall

Settings → Apps → _Vibe Time & Billing_ → Uninstall. Then, optionally,
remove the device entry under Windows Credential Manager → Windows
Credentials → `com.kisaes.vibe-tb`.
