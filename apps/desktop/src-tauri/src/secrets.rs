// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// DS-3 — OS credential store access (Windows Credential Manager, macOS
// Keychain, Secret Service on Linux) plus a stable per-install device id.
// Keys are namespaced under the bundle identifier; the web app only ever
// stores the desktop refresh credential here — never the session cookie.

use serde::Serialize;
use tauri::{AppHandle, Runtime};

const SERVICE: &str = "com.kisaes.vibe-tb";
const DEVICE_ID_KEY: &str = "device-id";

fn entry(key: &str) -> Result<keyring::Entry, String> {
    if key.is_empty()
        || key.len() > 64
        || !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return Err("invalid_key".into());
    }
    keyring::Entry::new(SERVICE, key).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn secret_get(key: String) -> Result<Option<String>, String> {
    match entry(&key)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn secret_set(key: String, value: String) -> Result<(), String> {
    if value.len() > 4096 {
        return Err("value_too_long".into());
    }
    entry(&key)?.set_password(&value).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn secret_delete(key: String) -> Result<(), String> {
    match entry(&key)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    device_id: String,
    hostname: String,
    os: String,
    app_version: String,
}

fn device_id() -> Result<String, String> {
    let e = entry(DEVICE_ID_KEY)?;
    match e.get_password() {
        Ok(v) if !v.is_empty() => Ok(v),
        _ => {
            let id = format!("dev_{}", uuid::Uuid::new_v4().simple());
            e.set_password(&id).map_err(|e| e.to_string())?;
            Ok(id)
        }
    }
}

#[tauri::command]
pub fn device_info<R: Runtime>(app: AppHandle<R>) -> Result<DeviceInfo, String> {
    let host = hostname::get()
        .ok()
        .and_then(|h| h.into_string().ok())
        .unwrap_or_else(|| "unknown-host".into());
    Ok(DeviceInfo {
        device_id: device_id()?,
        hostname: host,
        os: std::env::consts::OS.to_string(),
        app_version: app.package_info().version.to_string(),
    })
}

#[tauri::command]
pub fn app_version<R: Runtime>(app: AppHandle<R>) -> String {
    app.package_info().version.to_string()
}
