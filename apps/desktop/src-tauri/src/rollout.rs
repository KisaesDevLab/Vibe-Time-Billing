// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// DS-3 — auto-update + start-at-login.
//
// Updates: the manifest lives on the appliance (apps/api/src/desktop/
// releases.ts). We check on launch and every 6 h in the background and
// emit `desktop:update-available`; the web banner calls `install_update`,
// which downloads, verifies the minisign signature against the pubkey in
// tauri.conf.json, installs (passive NSIS) and relaunches.

use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_updater::UpdaterExt;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheck {
    available: bool,
    version: Option<String>,
    notes: Option<String>,
    current_version: String,
}

#[derive(Serialize, Clone)]
struct UpdateAvailable {
    version: String,
    notes: Option<String>,
}

fn updater<R: Runtime>(app: &AppHandle<R>) -> Result<tauri_plugin_updater::Updater, String> {
    // Manifest lives on whichever appliance this shell is connected to.
    let Some(server) = crate::server::server_url(app) else {
        return Err("no_server".into());
    };
    let endpoint = server
        .join("desktop/latest.json")
        .map_err(|e| e.to_string())?;
    app.updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())
}

async fn check<R: Runtime>(app: &AppHandle<R>) -> Result<UpdateCheck, String> {
    let current = app.package_info().version.to_string();
    let updater = updater(app)?;
    match updater.check().await.map_err(|e| e.to_string())? {
        Some(u) => Ok(UpdateCheck {
            available: true,
            version: Some(u.version.clone()),
            notes: u.body.clone(),
            current_version: current,
        }),
        None => Ok(UpdateCheck {
            available: false,
            version: None,
            notes: None,
            current_version: current,
        }),
    }
}

#[tauri::command]
pub async fn check_for_update<R: Runtime>(app: AppHandle<R>) -> Result<UpdateCheck, String> {
    check(&app).await
}

#[tauri::command]
pub async fn install_update<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let updater = updater(&app)?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        return Err("no_update".into());
    };
    update
        .download_and_install(|_chunk, _total| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    crate::files::purge_cache(&app, true);
    app.restart();
}

/// Launch + every 6 h. Errors (no manifest yet, offline, placeholder
/// pubkey) are swallowed — the banner simply never appears.
pub fn spawn_update_checker<R: Runtime>(app: AppHandle<R>) {
    tauri::async_runtime::spawn(async move {
        // Give the webview a moment so the banner has somewhere to land.
        tokio::time::sleep(Duration::from_secs(20)).await;
        loop {
            if let Ok(r) = check(&app).await {
                if r.available {
                    let _ = app.emit(
                        "desktop:update-available",
                        UpdateAvailable {
                            version: r.version.unwrap_or_default(),
                            notes: r.notes,
                        },
                    );
                }
            }
            tokio::time::sleep(Duration::from_secs(6 * 3600)).await;
        }
    });
}

#[tauri::command]
pub fn get_autostart<R: Runtime>(app: AppHandle<R>) -> Result<bool, String> {
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_autostart<R: Runtime>(app: AppHandle<R>, enabled: bool) -> Result<(), String> {
    let al = app.autolaunch();
    let current = al.is_enabled().unwrap_or(false);
    if enabled == current {
        return Ok(());
    }
    if enabled {
        al.enable().map_err(|e| e.to_string())
    } else {
        al.disable().map_err(|e| e.to_string())
    }
}
