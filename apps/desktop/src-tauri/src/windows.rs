// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// DS-1 — the always-on-top mini timer window. Created lazily the first
// time it is shown; hidden (not destroyed) afterwards so its webview keeps
// its state. It loads the same SPA with `?__window=timer`, which App.tsx
// turns into the widget-only render.

use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};

pub const TIMER_LABEL: &str = "timer";

pub fn show_timer_widget_impl<R: Runtime>(app: &AppHandle<R>, show: bool) -> tauri::Result<()> {
    if let Some(w) = app.get_webview_window(TIMER_LABEL) {
        if show {
            w.show()?;
            w.set_focus()?;
        } else {
            w.hide()?;
        }
        return Ok(());
    }
    if !show {
        return Ok(());
    }
    // Same origin as the main window so the session cookie is shared.
    let url = match crate::server::server_url(app) {
        Some(mut u) => {
            u.set_query(Some("__window=timer"));
            WebviewUrl::External(u)
        }
        None => return Ok(()), // not connected yet — nothing to show
    };
    let w = WebviewWindowBuilder::new(app, TIMER_LABEL, url)
        .title("Vibe PM timer")
        .inner_size(320.0, 72.0)
        .min_inner_size(260.0, 60.0)
        .max_inner_size(520.0, 120.0)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(true)
        .transparent(false)
        .visible(true)
        .build()?;
    // Closing the widget hides it; the tray / hotkey bring it back.
    let handle = w.clone();
    w.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = handle.hide();
        }
    });
    Ok(())
}

#[tauri::command]
pub fn show_timer_widget<R: Runtime>(app: AppHandle<R>, show: bool) -> Result<(), String> {
    show_timer_widget_impl(&app, show).map_err(|e| e.to_string())
}
