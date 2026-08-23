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
        .inner_size(340.0, 88.0)
        .min_inner_size(300.0, 88.0)
        .max_inner_size(560.0, 300.0)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false)
        .transparent(true)
        .visible(true)
        .build()?;
    // Closing the widget hides it; the tray / hotkey bring it back.
    let handle = w.clone();
    w.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = handle.hide();
            let app = handle.app_handle().clone();
            crate::tray::refresh_menu(&app);
            crate::menu::refresh(&app);
        }
    });
    Ok(())
}

/// Show ↔ hide, then refresh the tray/menu labels.
pub fn toggle_timer_widget_impl<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let visible = app
        .get_webview_window(TIMER_LABEL)
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false);
    show_timer_widget_impl(app, !visible)?;
    crate::tray::refresh_menu(app);
    crate::menu::refresh(app);
    Ok(())
}

#[tauri::command]
pub fn show_timer_widget<R: Runtime>(app: AppHandle<R>, show: bool) -> Result<(), String> {
    show_timer_widget_impl(&app, show).map_err(|e| e.to_string())?;
    crate::tray::refresh_menu(&app);
    crate::menu::refresh(&app);
    Ok(())
}

/// The widget grows to list parked timers; width is preserved.
#[tauri::command]
pub fn resize_timer_widget<R: Runtime>(app: AppHandle<R>, height: f64) -> Result<(), String> {
    let Some(w) = app.get_webview_window(TIMER_LABEL) else {
        return Ok(());
    };
    let scale = w.scale_factor().unwrap_or(1.0);
    let width = w
        .inner_size()
        .map(|s| s.width as f64 / scale)
        .unwrap_or(340.0);
    let h = height.clamp(88.0, 300.0);
    w.set_size(tauri::LogicalSize::new(width, h))
        .map_err(|e| e.to_string())
}

/// Focus the main window and navigate its SPA (same dual-delivery trick as
/// menu actions: event + eval, so it works regardless of event permissions).
#[tauri::command]
pub fn open_main_at<R: Runtime>(app: AppHandle<R>, path: String) -> Result<(), String> {
    if !path.starts_with('/') || path.starts_with("//") {
        return Err("invalid_path".into());
    }
    crate::tray::show_main(&app);
    let _ = tauri::Emitter::emit(&app, "menu:navigate", serde_json::json!({ "path": path }));
    if let Some(w) = app.get_webview_window("main") {
        let js = format!(
            "window.dispatchEvent(new CustomEvent('vibe:desktop-navigate',{{detail:{}}}));",
            serde_json::json!({ "path": path, "nonce": crate::state::now_ms() })
        );
        let _ = w.eval(&js);
    }
    Ok(())
}

#[tauri::command]
pub fn toggle_timer_widget<R: Runtime>(app: AppHandle<R>) -> Result<bool, String> {
    toggle_timer_widget_impl(&app).map_err(|e| e.to_string())?;
    Ok(app
        .get_webview_window(TIMER_LABEL)
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false))
}

#[tauri::command]
pub fn timer_widget_visible<R: Runtime>(app: AppHandle<R>) -> bool {
    app.get_webview_window(TIMER_LABEL)
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false)
}
