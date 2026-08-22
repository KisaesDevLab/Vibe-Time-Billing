// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// DS-1 — system tray. The web app pushes the timer list + running clock
// (`set_tray_state`); we rebuild the menu and keep the tooltip ticking
// locally from `synced_at_ms`, so there is no per-second IPC. Menu clicks
// are forwarded to the web app as `tray:action` events; the provider there
// does the real work against the API.

use std::sync::atomic::Ordering;
use std::time::Duration;

use serde::Serialize;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use crate::state::{now_ms, AppState, TrayState};

pub const TRAY_ID: &str = "vibe-tray";

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TrayAction {
    pub kind: &'static str,
    pub timer_id: Option<String>,
}

fn emit_action<R: Runtime>(app: &AppHandle<R>, kind: &'static str, timer_id: Option<String>) {
    let _ = app.emit("tray:action", TrayAction { kind, timer_id });
}

pub fn show_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn fmt_clock(secs: u64) -> String {
    let h = secs / 3600;
    let m = (secs % 3600) / 60;
    let s = secs % 60;
    if h > 0 {
        format!("{h}:{m:02}:{s:02}")
    } else {
        format!("{m}:{s:02}")
    }
}

fn live_elapsed(state: &TrayState) -> u64 {
    if state.active_id.is_none() {
        return 0;
    }
    let drift = now_ms().saturating_sub(state.synced_at_ms) / 1000;
    state.active_elapsed_seconds + drift
}

fn tooltip(state: &TrayState) -> String {
    match (&state.active_id, &state.active_label) {
        (Some(_), Some(label)) => format!("{} · {}", label, fmt_clock(live_elapsed(state))),
        (Some(_), None) => format!("Timer · {}", fmt_clock(live_elapsed(state))),
        _ => {
            let paused = state.timers.iter().filter(|t| t.status == "PAUSED").count();
            if paused > 0 {
                format!(
                    "Vibe — {paused} paused timer{}",
                    if paused == 1 { "" } else { "s" }
                )
            } else {
                "Vibe Time & Billing".to_string()
            }
        }
    }
}

fn build_menu<R: Runtime>(app: &AppHandle<R>, state: &TrayState) -> tauri::Result<Menu<R>> {
    let menu = Menu::new(app)?;

    if let (Some(_), Some(label)) = (&state.active_id, &state.active_label) {
        let header = MenuItem::with_id(
            app,
            "hdr",
            format!("▶ {} · {}", label, fmt_clock(live_elapsed(state))),
            false,
            None::<&str>,
        )?;
        menu.append(&header)?;
        menu.append(&MenuItem::with_id(
            app,
            "pause",
            "Pause",
            true,
            None::<&str>,
        )?)?;
    } else {
        let header = MenuItem::with_id(app, "hdr", "No timer running", false, None::<&str>)?;
        menu.append(&header)?;
    }

    menu.append(&MenuItem::with_id(
        app,
        "start",
        "Start timer…",
        true,
        None::<&str>,
    )?)?;

    let paused: Vec<_> = state
        .timers
        .iter()
        .filter(|t| t.status == "PAUSED")
        .collect();
    if !paused.is_empty() {
        let sub = Submenu::with_id(app, "switch", "Switch to", true)?;
        for t in paused {
            sub.append(&MenuItem::with_id(
                app,
                format!("switch:{}", t.id),
                &t.label,
                true,
                None::<&str>,
            )?)?;
        }
        menu.append(&sub)?;
    }

    if state.active_id.is_some() || !state.timers.is_empty() {
        menu.append(&MenuItem::with_id(
            app,
            "finish",
            "Finish on Time page…",
            true,
            None::<&str>,
        )?)?;
    }

    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(
        app,
        "widget",
        "Show timer widget",
        true,
        None::<&str>,
    )?)?;
    menu.append(&MenuItem::with_id(
        app,
        "open",
        "Open Vibe",
        true,
        None::<&str>,
    )?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(
        app,
        "quit",
        "Quit Vibe",
        true,
        None::<&str>,
    )?)?;
    Ok(menu)
}

pub fn build_tray<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<TrayIcon<R>> {
    let state = app.state::<AppState>();
    let initial = state.tray.lock().map(|s| s.clone()).unwrap_or_default();
    let menu = build_menu(app, &initial)?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip(tooltip(&initial))
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            match id {
                "start" => emit_action(app, "start", None),
                "pause" => emit_action(app, "pause", None),
                "finish" => emit_action(app, "finish", None),
                "widget" => {
                    let _ = crate::windows::show_timer_widget_impl(app, true);
                }
                "open" => show_main(app),
                "quit" => {
                    crate::files::purge_cache(app, true);
                    app.exit(0);
                }
                other => {
                    if let Some(tid) = other.strip_prefix("switch:") {
                        emit_action(app, "switch", Some(tid.to_string()));
                    }
                }
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    let tray = builder.build(app)?;

    // 1 s tooltip tick while a timer is running; menu header refreshes each
    // 15 s (rebuilding the menu every second is wasteful and can flicker).
    let handle = app.clone();
    std::thread::Builder::new()
        .name("vibe-tray-tick".into())
        .spawn(move || {
            let mut n: u64 = 0;
            loop {
                std::thread::sleep(Duration::from_secs(1));
                n += 1;
                let st = handle.state::<AppState>();
                let snapshot = match st.tray.lock() {
                    Ok(s) => s.clone(),
                    Err(_) => continue,
                };
                if let Some(tray) = handle.tray_by_id(TRAY_ID) {
                    let _ = tray.set_tooltip(Some(tooltip(&snapshot)));
                    if snapshot.active_id.is_some() && n % 15 == 0 {
                        if let Ok(menu) = build_menu(&handle, &snapshot) {
                            let _ = tray.set_menu(Some(menu));
                        }
                    }
                }
            }
        })
        .ok();

    Ok(tray)
}

#[tauri::command]
pub fn set_tray_state<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    new_state: TrayState,
) -> Result<(), String> {
    {
        let mut s = state.tray.lock().map_err(|_| "state_poisoned")?;
        *s = new_state;
    }
    let snapshot = state.tray.lock().map_err(|_| "state_poisoned")?.clone();
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let menu = build_menu(&app, &snapshot).map_err(|e| e.to_string())?;
        tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;
        tray.set_tooltip(Some(tooltip(&snapshot)))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn set_close_to_tray(state: State<'_, AppState>, enabled: bool) {
    state.close_to_tray.store(enabled, Ordering::Relaxed);
}

#[tauri::command]
pub fn show_main_window<R: Runtime>(app: AppHandle<R>) {
    show_main(&app);
}

#[tauri::command]
pub fn broadcast_timers_changed<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    app.emit("desktop:timers-changed", ())
        .map_err(|e| e.to_string())
}
