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
| Menu          | Native menu bar: File, Timer, Favorites (Ctrl+D adds the current page; Ctrl+1…9 jump), View, Help | `menu.rs`                   |
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

## How it loads the app

Nothing firm-specific is baked into the build. On first launch the shell
shows a bundled **Connect to your Vibe server** page (`connect/index.html`);
the user enters the staff URL (the same one they use in a browser). The shell
probes `<url>/api/auth/me`, stores the URL in its config dir, and from then
on the main window loads the staff app **from the appliance** — cookies,
CSRF, relative `/api` calls and the web app's own updates work exactly as in
a browser, and `withGlobalTauri` + the `remote` capability inject
`window.__TAURI__` into that remote page so the native extras light up.
The mini timer window loads the same origin with `?__window=timer`, and the
auto-updater reads `<url>/desktop/latest.json`. *Account → Desktop app →
Change server…* forgets the URL and restarts on the connect page.

Consequences: one installer serves every firm; no `@vibe/web` build is
needed to build the shell; the CSP in `tauri.conf.json` only governs the
connect page (the remote app is governed by the appliance's own headers —
the staff host must not send a `Content-Security-Policy` whose
`connect-src` blocks `ipc:` / `http://ipc.localhost`, or the shell's IPC
from the remote page is refused; the shipped Caddy templates send none).

## Run / build

Driven explicitly (not by the repo's `pnpm dev`/`pnpm build` fan-out) so web
CI never needs Rust:

```bash
# Dev: opens the connect page; enter http://localhost:5195 (Vite, started
# separately with `pnpm --filter @vibe/web dev`) or any appliance URL.
pnpm --filter @vibe/desktop tauri dev

# Production bundle (NSIS installer + updater artefacts; MSI dropped — WiX
# chokes on the '&' in the product name and the updater only needs NSIS)
pnpm --filter @vibe/desktop tauri build
```

## First-compile checklist

Places where a crate's API may have moved since this was written. Each is a
one-line fix; none changes behaviour.

| Where | Watch for |
| --- | --- |
| `server.rs` / `lib.rs` | `WebviewWindow::navigate`, `WebviewWindowBuilder::disable_drag_drop_handler`, `Updater`/`updater_builder().endpoints()` names |
| `capture.rs` | ✅ fixed 2026-08-22: xcap accessors return plain values |
| `watchers.rs` | `user-idle` — `UserIdle::get_time()?.as_seconds()` |
| `notify.rs` (Windows) | ✅ `Toast::on_activated` compiles; `Toast::tag` does not exist (removed) |
| `notify.rs` | `WebviewWindow::set_overlay_icon` (Windows) / `set_badge_count` (others) — Tauri ≥ 2.2 |
| `hotkeys.rs` | `tauri-plugin-global-shortcut` — `ShortcutEvent::state()` vs field; `Shortcut::from_str` |
| `lib.rs` | `tauri-plugin-deep-link` — `event.urls()`; `register_all()` is desktop-only |
| `secrets.rs` | `keyring 3` — `delete_credential()` (was `delete_password()` in 2.x); feature names |
| `files.rs` | `tauri::ipc::Response::new(Vec<u8>)` returns raw bytes to JS (`readOutboxFile` handles both shapes) |

`tauri.conf.json` → `plugins.updater.pubkey` already holds the firm's
updater public key (generated 2026-08-22; private half kept off-repo in the
appliance secrets store). The private key + its (empty) password must be set
as the GitHub secrets named in `.github/workflows/desktop-build.yml` before
the first CI build. Rotating the key means rebuilding + reinstalling every
client, so keep the private key backed up. The workflow writes a *relative*
download URL into `latest.json` (`/desktop/dl/<file>`), which the updater
resolves against whichever appliance the shell is connected to.

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
| `get_server_url`, `set_server_url(url)`, `clear_server_url` | which appliance |
| `check_for_update`, `install_update`, `get_autostart`, `set_autostart` | rollout |
| `download_and_open(url, filename)`, `open_external(url)`, `set_outbox_watch(enabled)`, `read_outbox_file(path)`, `delete_outbox_file(path)` | files |

Shell → web actions are delivered twice — as a Tauri event and as a DOM `CustomEvent` `eval`'d into the main window (`vibe:desktop-action` / `vibe:desktop-menu` / `vibe:desktop-navigate`) — and de-duplicated by nonce, so menus keep working even if event permissions for the remote origin are wrong.

Events emitted to the web app: `tray:action`, `menu:action`, `menu:navigate`, `menu:about`, `desktop:hotkey`,
`desktop:idle-return`, `desktop:foreground-window`,
`desktop:notification-click`, `desktop:deep-link`,
`desktop:update-available`, `desktop:outbox-file`, `desktop:timers-changed`.

## Privacy notes

- Window capture stays in memory and goes only to the firm's LAN OCR server.
- The foreground watcher (off by default) reads window **titles** only.
- Toasts carry titles and ids, never document contents. The app registers its AppUserModelID under HKCU at startup so Windows shows toasts even for dev/portable runs; **Help → Send test notification** verifies it.
- Downloaded files live in the app cache and are purged on quit / after 24 h.
- The outbox PDF is deleted as soon as it is attached.
- The only secret on the workstation is the device refresh credential, in
  Windows Credential Manager; it is rotated on every use and revocable from
  Account → Desktop or by an admin.
