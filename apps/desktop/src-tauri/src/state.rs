// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Process-wide state shared between commands, the tray, and the watcher
// threads. Everything here is small and copy-on-read; threads hold a
// `Mutex` for microseconds, never across IPC.

use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayTimer {
    pub id: String,
    pub label: String,
    pub status: String, // RUNNING | PAUSED
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayState {
    pub timers: Vec<TrayTimer>,
    pub active_id: Option<String>,
    pub active_label: Option<String>,
    /// Elapsed seconds at `synced_at_ms`; the tray advances locally.
    pub active_elapsed_seconds: u64,
    pub synced_at_ms: u64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hotkeys {
    pub toggle: Option<String>,
    pub start: Option<String>,
    pub widget: Option<String>,
}

pub struct AppState {
    pub tray: Mutex<TrayState>,
    pub close_to_tray: AtomicBool,
    /// Seconds; 0 disables idle detection.
    pub idle_threshold_secs: AtomicU64,
    pub foreground_watch: AtomicBool,
    pub outbox_watch: AtomicBool,
    /// Native toasts we have shown, so a click can be resolved to its href.
    pub toasts: Mutex<Vec<(String, Option<String>)>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            tray: Mutex::new(TrayState::default()),
            close_to_tray: AtomicBool::new(true),
            idle_threshold_secs: AtomicU64::new(600),
            foreground_watch: AtomicBool::new(false),
            outbox_watch: AtomicBool::new(false),
            toasts: Mutex::new(Vec::new()),
        }
    }
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
