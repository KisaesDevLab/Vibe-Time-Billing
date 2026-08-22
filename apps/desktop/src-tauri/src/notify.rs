// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// DS-2 — native notifications + badge.
//
// Windows uses WinRT toasts directly (tauri-winrt-notification) because we
// need the activation callback: a click must focus the app and navigate to
// the event's href, which the generic notification plugin cannot deliver
// on desktop. The toast's AppUserModelID is the bundle identifier, which
// the NSIS installer stamps on the Start Menu shortcut; in `cargo tauri
// dev` (no shortcut) we fall back to PowerShell's AUMID so toasts still
// show while developing.
//
// Badge: macOS/Linux get a real dock badge; Windows gets a red overlay dot
// on the taskbar icon (Windows has no numeric badge API for Win32 apps).

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use crate::state::AppState;

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NativeNotification {
    pub id: String,
    pub title: String,
    pub body: Option<String>,
    pub href: Option<String>,
    pub category: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct NotificationClick {
    id: String,
    href: Option<String>,
}

fn remember<R: Runtime>(app: &AppHandle<R>, id: &str, href: Option<String>) {
    let state = app.state::<AppState>();
    if let Ok(mut v) = state.toasts.lock() {
        v.retain(|(x, _)| x != id);
        v.push((id.to_string(), href));
        if v.len() > 50 {
            let drop = v.len() - 50;
            v.drain(0..drop);
        }
    }
}

pub fn fire_click<R: Runtime>(app: &AppHandle<R>, id: &str) {
    let href = app
        .state::<AppState>()
        .toasts
        .lock()
        .ok()
        .and_then(|v| v.iter().find(|(x, _)| x == id).and_then(|(_, h)| h.clone()));
    crate::tray::show_main(app);
    let _ = app.emit(
        "desktop:notification-click",
        NotificationClick {
            id: id.to_string(),
            href,
        },
    );
}

#[cfg(windows)]
fn show_toast<R: Runtime>(app: &AppHandle<R>, n: &NativeNotification) -> Result<(), String> {
    use tauri_winrt_notification::{Duration, Sound, Toast};

    let aumid: String = if cfg!(debug_assertions) {
        Toast::POWERSHELL_APP_ID.to_string()
    } else {
        app.config().identifier.clone()
    };
    let id = n.id.clone();
    let handle = app.clone();
    let mut toast = Toast::new(&aumid)
        .title(&n.title)
        .text1(n.body.as_deref().unwrap_or(""))
        .sound(Some(Sound::Default))
        .duration(Duration::Short)
        .on_activated(move |_arg| {
            fire_click(&handle, &id);
            Ok(())
        });
    if let Some(tag) = n.id.get(..64) {
        toast = toast.tag(tag);
    }
    toast.show().map_err(|e| format!("toast: {e:?}"))
}

#[cfg(not(windows))]
fn show_toast<R: Runtime>(app: &AppHandle<R>, n: &NativeNotification) -> Result<(), String> {
    let mut note = notify_rust::Notification::new();
    note.summary(&n.title)
        .body(n.body.as_deref().unwrap_or(""))
        .appname("Vibe Time & Billing");
    #[cfg(target_os = "linux")]
    {
        let id = n.id.clone();
        let handle = app.clone();
        let h = note.show().map_err(|e| e.to_string())?;
        std::thread::spawn(move || {
            h.wait_for_action(|action| {
                if action == "default" {
                    fire_click(&handle, &id);
                }
            });
        });
        return Ok(());
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = app;
        note.show().map(|_| ()).map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub fn notify<R: Runtime>(
    app: AppHandle<R>,
    notification: NativeNotification,
) -> Result<(), String> {
    remember(&app, &notification.id, notification.href.clone());
    show_toast(&app, &notification)
}

/// 16×16 RGBA red dot used as the Windows taskbar overlay.
fn overlay_dot() -> tauri::image::Image<'static> {
    const W: usize = 16;
    let mut rgba = vec![0u8; W * W * 4];
    let c = (W as f32 - 1.0) / 2.0;
    for y in 0..W {
        for x in 0..W {
            let dx = x as f32 - c;
            let dy = y as f32 - c;
            let d = (dx * dx + dy * dy).sqrt();
            let a = if d <= 6.0 {
                255
            } else if d <= 7.0 {
                ((7.0 - d) * 255.0) as u8
            } else {
                0
            };
            let i = (y * W + x) * 4;
            rgba[i] = 0xD3;
            rgba[i + 1] = 0x2F;
            rgba[i + 2] = 0x2F;
            rgba[i + 3] = a;
        }
    }
    tauri::image::Image::new_owned(rgba, W as u32, W as u32)
}

#[tauri::command]
pub fn set_badge<R: Runtime>(app: AppHandle<R>, count: u32) -> Result<(), String> {
    let Some(w) = app.get_webview_window("main") else {
        return Ok(());
    };
    #[cfg(windows)]
    {
        if count > 0 {
            w.set_overlay_icon(Some(overlay_dot()))
                .map_err(|e| e.to_string())?;
        } else {
            w.set_overlay_icon(None).map_err(|e| e.to_string())?;
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = overlay_dot; // keep the helper referenced on every platform
        w.set_badge_count(if count > 0 { Some(count as i64) } else { None })
            .map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub fn clear_toasts(state: State<'_, AppState>) {
    if let Ok(mut v) = state.toasts.lock() {
        v.clear();
    }
}
