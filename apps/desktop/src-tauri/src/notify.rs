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
    /// Kept for parity with the web contract; muting is decided web-side.
    #[allow(dead_code)]
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
    let guard = state.toasts.lock();
    if let Ok(mut v) = guard {
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

    // Registered under HKCU by register_aumid() at startup, so it works in
    // dev and portable runs as well as installed ones.
    let aumid: String = app.config().identifier.clone();
    let id = n.id.clone();
    let handle = app.clone();
    Toast::new(&aumid)
        .title(&n.title)
        .text1(n.body.as_deref().unwrap_or(""))
        .sound(Some(Sound::Default))
        .duration(Duration::Short)
        .on_activated(move |_arg| {
            fire_click(&handle, &id);
            Ok(())
        })
        .show()
        .map_err(|e| format!("toast: {e:?}"))
}

#[cfg(not(windows))]
fn show_toast<R: Runtime>(app: &AppHandle<R>, n: &NativeNotification) -> Result<(), String> {
    let mut note = notify_rust::Notification::new();
    note.summary(&n.title)
        .body(n.body.as_deref().unwrap_or(""))
        .appname("Vibe Practice Management");
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

/// Windows shows toasts only for a registered AppUserModelID. The NSIS
/// installer stamps one on the Start Menu shortcut, but `cargo tauri dev`
/// and portable runs have no shortcut — so register the AUMID under HKCU
/// ourselves (supported since Windows 10 1803). Idempotent; best-effort.
#[cfg(windows)]
pub fn register_aumid<R: Runtime>(app: &AppHandle<R>) {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    let aumid = app.config().identifier.clone();
    let Ok((key, _)) = RegKey::predef(HKEY_CURRENT_USER)
        .create_subkey(format!("Software\\Classes\\AppUserModelId\\{aumid}"))
    else {
        return;
    };
    let _ = key.set_value("DisplayName", &"Vibe Practice Management");
    if let Ok(exe) = std::env::current_exe() {
        // The exe's embedded icon is what Windows renders next to the toast.
        let _ = key.set_value("IconUri", &exe.to_string_lossy().to_string());
    }
    let _ = key.set_value("ShowInSettings", &1u32);
}

#[cfg(not(windows))]
pub fn register_aumid<R: Runtime>(_app: &AppHandle<R>) {}

/// Help → Send test notification (also used by Account → Desktop).
pub fn show_test_toast<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let n = NativeNotification {
        id: format!("test:{}", crate::state::now_ms()),
        title: "Vibe notifications are working".into(),
        body: Some(
            "Click me to return to Vibe. You can mute categories in Account → Desktop.".into(),
        ),
        href: Some("/account".into()),
        category: Some("system".into()),
    };
    remember(app, &n.id, n.href.clone());
    show_toast(app, &n)
}

#[tauri::command]
pub fn test_notification<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    show_test_toast(&app)
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
    // Named guard: a tail-position `if let` would keep the lock temporary
    // alive past `state` (E0597), as the first CI compile showed.
    let guard = state.toasts.lock();
    if let Ok(mut v) = guard {
        v.clear();
    }
}
