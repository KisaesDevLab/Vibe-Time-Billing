<!-- SPDX-License-Identifier: PolyForm-Small-Business-1.0.0 -->

# @vibe/desktop — Tauri shell

A [Tauri 2](https://tauri.app) desktop wrapper around the Vibe T&B staff web
app (`@vibe/web`). In a browser tab the staff app is complete; the shell adds
what a tab cannot do:

| Area          | What the shell adds                                                                                        | Code                        |
| ------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------- |
| Capture       | Native window capture of UltraTax CS for **Capture Client Info** (in memory, never on disk)               | `src/capture.rs`            |
| Timer         | Tray icon with live clock + switch/pause/finish menu, global hotkeys, idle-return prompt, floating widget | `tray.rs` `hotkeys.rs` `watchers.rs` `windows.rs` |
| Notifications | Windows toasts (click opens the item), taskbar badge, quiet hours + per-category mute                      | `notify.rs`                 |
| Links         | `vibetb://` deep links, single instance                                                                     | `lib.rs`                    |
| Rollout       | Signed auto-update from the appliance, start at login, remembered device (Credential Manager)             | `rollout.rs` `secrets.rs`   |
| Files         | Open files with the default app (cache purged), print-to-PDF outbox → attach to client                     | `files.rs`                  |

The web side of every feature lives in `apps/web/src/lib/desktop.ts` (the
command/event contract), `components/DesktopShellBridge.tsx`,
`timer/DesktopTimerBridge.tsx`, `pages/desktop/TimerWidget.tsx` and
`pages/account/DesktopSettingsCard.tsx`. Everything is gated on
`window.__TAURI__`; the browser build is unaffected. The design + rationale
is in `docs/architecture/DESKTOP_BUILD_PLAN.md`.

## Status — **not yet compiled**

The Rust side was written against the Tauri 2 / plugin APIs but has not been
built: the appliance has no C toolchain or WebKit, and the real target is a
Windows workstation. `rustfmt` confirms every file parses. Expect a short
first-compile pass; the spots most likely to need a touch are listed below.

## Prerequisites (build machine — Windows)

- Rust stable (`rustup`), MSVC Build Tools ("Desktop development with C++")
- WebView2 runtime (ships with Windows 11; the installer bootstraps it otherwise)
- Node 24 + pnpm (the repo's versions)

Linux for development only: `webkit2gtk-4.1`, `libayatana-appindicator3`,
`libdbus-1-dev` (notify-rust), `libxdo-dev`.

## Run / build

Driven explicitly (not by the repo's `pnpm dev`/`pnpm build` fan-out) so web
CI never needs Rust:

```bash
# Dev: launches the Vite dev server (@vibe/web on :5195) then the native window
pnpm --filter @vibe/desktop tauri dev

# Production bundle (builds @vibe/web first, then packages NSIS + MSI)
pnpm --filter @vibe/desktop tauri build
```

The API is reached exactly as in the browser: the SPA calls `/api/...`, which
the Vite dev proxy forwards to `http://localhost:3001` in dev and the
appliance origin serves in production. The CSP in `tauri.conf.json` lists
those origins plus Backblaze (presigned file uploads/downloads); add your
appliance host there before shipping.

## First-compile checklist

Places where a crate's API may have moved since this was written. Each is a
one-line fix; none changes behaviour.

| Where | Watch for |
| --- | --- |
| `capture.rs` | `xcap 0.3` accessor return types (`id()`, `title()`, `width()` are `Result`s here) |
| `watchers.rs` | `user-idle` — `UserIdle::get_time()?.as_seconds()` |
| `notify.rs` (Windows) | `tauri-winrt-notification` — `Toast::on_activated` closure signature; `Toast::POWERSHELL_APP_ID` |
| `notify.rs` | `WebviewWindow::set_overlay_icon` (Windows) / `set_badge_count` (others) — Tauri ≥ 2.2 |
| `hotkeys.rs` | `tauri-plugin-global-shortcut` — `ShortcutEvent::state()` vs field; `Shortcut::from_str` |
| `lib.rs` | `tauri-plugin-deep-link` — `event.urls()`; `register_all()` is desktop-only |
| `secrets.rs` | `keyring 3` — `delete_credential()` (was `delete_password()` in 2.x); feature names |
| `files.rs` | `tauri::ipc::Response::new(Vec<u8>)` returns raw bytes to JS (`readOutboxFile` handles both shapes) |

Then update `tauri.conf.json`:

1. `plugins.updater.pubkey` — paste the public key from
   `pnpm --filter @vibe/desktop tauri signer generate -w ~/.tauri/vibe.key`
   and put the private key + password into the GitHub secrets named in
   `.github/workflows/desktop-build.yml`.
2. `plugins.updater.endpoints` and the `url` the workflow writes into
   `latest.json` — the appliance host serving `/desktop/latest.json`.
3. `app.security.csp.connect-src` — the appliance host.

## Icons

`src-tauri/icons/` was generated from `apps/portal/public/icon-512.png` with
`pnpm --filter @vibe/desktop tauri icon <png>`. Re-run with the firm logo to
rebrand; commit the output.

## Publishing an update

1. Bump `version` in `tauri.conf.json` and `Cargo.toml` (keep them equal).
2. Tag `desktop-vX.Y.Z` (or run the `desktop-build` workflow by hand).
3. Download the `vibe-desktop-windows` artifact and copy its contents into
   `DESKTOP_RELEASES_DIR` on the appliance (`latest.json`, the
   `*-setup.exe`, its `.sig`). The API serves them at `/desktop/latest.json`
   and `/desktop/dl/<file>`; installed shells check on launch and every 6 h
   and show a "Restart to update" banner.

First install on a workstation is manual (run the `-setup.exe`); after
that updates are automatic.

## Commands exposed to the web app

See `apps/web/src/lib/desktop.ts` for the typed facade. Summary:

| command | purpose |
| --- | --- |
| `list_capturable_windows`, `capture_window(id)` | Capture Client Info |
| `set_tray_state(newState)`, `set_close_to_tray`, `show_main_window`, `broadcast_timers_changed`, `show_timer_widget(show)` | tray + windows |
| `set_hotkeys(hotkeys)` → `{ok, failed}` | global shortcuts |
| `set_idle_threshold(seconds)`, `set_foreground_watch(enabled)` | watchers |
| `notify(notification)`, `set_badge(count)`, `clear_toasts` | notifications |
| `secret_get/set/delete(key)`, `device_info`, `app_version` | credential store |
| `check_for_update`, `install_update`, `get_autostart`, `set_autostart` | rollout |
| `download_and_open(url, filename)`, `open_external(url)`, `set_outbox_watch(enabled)`, `read_outbox_file(path)`, `delete_outbox_file(path)` | files |

Events emitted to the web app: `tray:action`, `desktop:hotkey`,
`desktop:idle-return`, `desktop:foreground-window`,
`desktop:notification-click`, `desktop:deep-link`,
`desktop:update-available`, `desktop:outbox-file`, `desktop:timers-changed`.

## Privacy notes

- Window capture stays in memory and goes only to the firm's LAN OCR server.
- The foreground watcher (off by default) reads window **titles** only.
- Toasts carry titles and ids, never document contents.
- Downloaded files live in the app cache and are purged on quit / after 24 h.
- The outbox PDF is deleted as soon as it is attached.
- The only secret on the workstation is the device refresh credential, in
  Windows Credential Manager; it is rotated on every use and revocable from
  Account → Desktop or by an admin.
