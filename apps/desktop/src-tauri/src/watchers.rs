// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// DS-1 — two background watchers, each a plain thread polling every few
// seconds and emitting an event only on a state change:
//
//   idle        user_idle reports seconds since the last input. Once it
//               crosses the threshold we remember the longest idle span;
//               when input resumes we emit `desktop:idle-return
//               { idleSeconds }` once. 0 threshold = off.
//   foreground  (opt-in, Windows only) the title + process name of the
//               foreground window, emitted as `desktop:foreground-window`
//               when it changes. Title text only — never pixels.

use std::sync::atomic::Ordering;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use crate::state::AppState;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct IdleReturn {
    idle_seconds: u64,
}

#[derive(Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ForegroundWindow {
    pub title: String,
    pub app_name: String,
}

pub fn spawn_idle_watcher<R: Runtime>(app: AppHandle<R>) {
    std::thread::Builder::new()
        .name("vibe-idle".into())
        .spawn(move || {
            let mut idle_peak: u64 = 0;
            let mut was_idle = false;
            loop {
                std::thread::sleep(Duration::from_secs(5));
                let threshold = app
                    .state::<AppState>()
                    .idle_threshold_secs
                    .load(Ordering::Relaxed);
                if threshold == 0 {
                    was_idle = false;
                    idle_peak = 0;
                    continue;
                }
                let idle = match user_idle::UserIdle::get_time() {
                    Ok(t) => t.as_seconds(),
                    Err(_) => continue,
                };
                if idle >= threshold {
                    was_idle = true;
                    idle_peak = idle_peak.max(idle);
                } else if was_idle && idle < 10 {
                    let _ = app.emit(
                        "desktop:idle-return",
                        IdleReturn {
                            idle_seconds: idle_peak,
                        },
                    );
                    was_idle = false;
                    idle_peak = 0;
                }
            }
        })
        .ok();
}

#[cfg(windows)]
fn foreground_window() -> Option<ForegroundWindow> {
    use windows::Win32::Foundation::{CloseHandle, HWND};
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
    };

    unsafe {
        let hwnd: HWND = GetForegroundWindow();
        if hwnd.0.is_null() {
            return None;
        }
        let len = GetWindowTextLengthW(hwnd);
        let mut buf = vec![0u16; (len.max(0) as usize) + 1];
        let n = GetWindowTextW(hwnd, &mut buf);
        let title = String::from_utf16_lossy(&buf[..n.max(0) as usize]);

        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        let mut app_name = String::new();
        if pid != 0 {
            if let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
                let mut path = vec![0u16; 1024];
                let mut size = path.len() as u32;
                if QueryFullProcessImageNameW(
                    h,
                    PROCESS_NAME_WIN32,
                    windows::core::PWSTR(path.as_mut_ptr()),
                    &mut size,
                )
                .is_ok()
                {
                    let full = String::from_utf16_lossy(&path[..size as usize]);
                    app_name = full.rsplit(['\\', '/']).next().unwrap_or("").to_string();
                }
                let _ = CloseHandle(h);
            }
        }
        Some(ForegroundWindow { title, app_name })
    }
}

#[cfg(not(windows))]
fn foreground_window() -> Option<ForegroundWindow> {
    // xcap exposes a focus flag on recent releases; fall back to "unknown"
    // rather than guessing. UltraTax only runs on Windows anyway.
    None
}

pub fn spawn_foreground_watcher<R: Runtime>(app: AppHandle<R>) {
    std::thread::Builder::new()
        .name("vibe-foreground".into())
        .spawn(move || {
            let mut last: Option<ForegroundWindow> = None;
            loop {
                std::thread::sleep(Duration::from_secs(3));
                if !app
                    .state::<AppState>()
                    .foreground_watch
                    .load(Ordering::Relaxed)
                {
                    last = None;
                    continue;
                }
                let Some(fg) = foreground_window() else {
                    continue;
                };
                if fg.title.is_empty() {
                    continue;
                }
                if last.as_ref() != Some(&fg) {
                    let _ = app.emit("desktop:foreground-window", fg.clone());
                    last = Some(fg);
                }
            }
        })
        .ok();
}

#[tauri::command]
pub fn set_idle_threshold(state: State<'_, AppState>, seconds: u64) {
    state.idle_threshold_secs.store(seconds, Ordering::Relaxed);
}

#[tauri::command]
pub fn set_foreground_watch(state: State<'_, AppState>, enabled: bool) {
    state.foreground_watch.store(enabled, Ordering::Relaxed);
}
