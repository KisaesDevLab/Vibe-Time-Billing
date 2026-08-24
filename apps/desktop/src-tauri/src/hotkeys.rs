// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// DS-1 — global shortcuts. The web app hands us up to three accelerator
// strings (Account → Desktop); we (re)register them and emit
// `desktop:hotkey { kind }` on press. Registration failures (already taken
// by another app) are reported back per key rather than failing the call.

use std::str::FromStr;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use crate::state::Hotkeys;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HotkeyRegistration {
    ok: Vec<&'static str>,
    failed: Vec<HotkeyFailure>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HotkeyFailure {
    kind: &'static str,
    error: String,
}

#[derive(Serialize, Clone)]
struct HotkeyEvent {
    kind: &'static str,
}

#[tauri::command]
pub fn set_hotkeys<R: Runtime>(
    app: AppHandle<R>,
    hotkeys: Hotkeys,
) -> Result<HotkeyRegistration, String> {
    let gs = app.global_shortcut();
    gs.unregister_all().map_err(|e| e.to_string())?;

    let mut out = HotkeyRegistration {
        ok: vec![],
        failed: vec![],
    };
    let wanted: [(&'static str, Option<String>); 3] = [
        ("toggle", hotkeys.toggle),
        ("start", hotkeys.start),
        ("widget", hotkeys.widget),
    ];
    for (kind, accel) in wanted {
        let Some(accel) = accel.filter(|s| !s.trim().is_empty()) else {
            continue;
        };
        let shortcut = match Shortcut::from_str(accel.trim()) {
            Ok(s) => s,
            Err(e) => {
                out.failed.push(HotkeyFailure {
                    kind,
                    error: format!("invalid: {e}"),
                });
                continue;
            }
        };
        let res = gs.on_shortcut(shortcut, move |app, _shortcut, event| {
            if event.state() == ShortcutState::Pressed {
                let _ = app.emit("desktop:hotkey", HotkeyEvent { kind });
            }
        });
        match res {
            Ok(()) => out.ok.push(kind),
            Err(e) => out.failed.push(HotkeyFailure {
                kind,
                error: e.to_string(),
            }),
        }
    }
    Ok(out)
}
