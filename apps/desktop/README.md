<!-- SPDX-License-Identifier: PolyForm-Small-Business-1.0.0 -->

# @vibe/desktop — Tauri shell

A thin [Tauri 2](https://tauri.app) desktop wrapper around the Vibe T&B staff
web app (`@vibe/web`). It exists for one reason the browser can't satisfy:
**native window capture** for the "Capture Client Info" flow, which
screenshots the UltraTax CS window and feeds it to the firm's local GLM-OCR
endpoint. In the browser the same screen renders normally; the capture button
only appears when running inside this shell (`window.__TAURI__` present).

## Prerequisites (build machine)

Tauri needs a Rust toolchain and the platform webview libs — see
<https://tauri.app/start/prerequisites/>. The real build target is the firm's
**Windows** workstation (that's where UltraTax runs). In short:

- Rust (`rustup`, stable)
- Windows: WebView2 (ships with Win 11) + MSVC build tools
- Linux (dev only): `webkit2gtk-4.1`, `libayatana-appindicator3`, etc.

## Run / build

These are driven explicitly (not via the repo's `pnpm dev`/`pnpm build`
fan-out) so the web CI, which has no Rust toolchain, is never asked to build
Rust:

```bash
# Dev: launches the Vite dev server (@vibe/web on :5195) then the native window
pnpm --filter @vibe/desktop tauri dev

# Production bundle (builds @vibe/web first, then packages)
pnpm --filter @vibe/desktop tauri build
```

The API is reached exactly as in the browser: the SPA calls `/api/...`, which
the Vite dev proxy forwards to `http://localhost:3001` in dev and the
appliance origin serves in production.

## App icons

`tauri build` requires the icon set referenced in `tauri.conf.json`. Generate
it once from the firm logo (not committed here):

```bash
pnpm --filter @vibe/desktop tauri icon path/to/logo.png
```

## Commands exposed to the web app

| command | returns | notes |
|---|---|---|
| `list_capturable_windows` | `[{ id, title, appName, width, height }]` | minimized windows filtered out |
| `capture_window(id)` | base64 PNG string | in-memory only, never written to disk |

See `src-tauri/src/lib.rs`. On Windows, xcap uses GDI BitBlt — fine for the
Win32 UltraTax window, but it can return black frames for GPU-accelerated or
occluded windows (RDP/Citrix). When that happens, use the print-to-PDF upload
fallback in the web app instead.
