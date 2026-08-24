// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// DS-0 — which appliance this shell talks to. Nothing is baked in: on first
// launch the bundled "connect" page asks for the firm's staff URL, we
// persist it in the app config dir, and from then on the main window loads
// the staff app *from that origin* (not a bundled copy). That keeps
// cookies, CSRF, relative `/api` calls and the web app's own updates
// exactly as in a browser; only the native extras come from the shell.
//
// The updater manifest is derived from the same origin
// (`<server>/desktop/latest.json`), so there is no per-firm build.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime, Url, WebviewUrl};

#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ServerConfig {
    pub url: Option<String>,
}

fn config_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("server.json"))
}

pub fn load<R: Runtime>(app: &AppHandle<R>) -> ServerConfig {
    config_path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save<R: Runtime>(app: &AppHandle<R>, cfg: &ServerConfig) -> Result<(), String> {
    let p = config_path(app)?;
    let json = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    std::fs::write(p, json).map_err(|e| e.to_string())
}

/// Accepts "app.firm.com", "https://app.firm.com/", "http://localhost:5195"
/// and returns a normalised origin with a trailing slash.
pub fn normalize(input: &str) -> Result<Url, String> {
    let mut s = input.trim().to_string();
    if s.is_empty() {
        return Err("empty".into());
    }
    if !s.contains("://") {
        s = format!("https://{s}");
    }
    let mut url = Url::parse(&s).map_err(|e| e.to_string())?;
    match url.scheme() {
        "https" => {}
        "http" => {
            let host = url.host_str().unwrap_or("");
            let local = host == "localhost" || host == "127.0.0.1" || host.ends_with(".local");
            if !local {
                return Err("https_required".into());
            }
        }
        _ => return Err("unsupported_scheme".into()),
    }
    if url.host_str().is_none() {
        return Err("missing_host".into());
    }
    url.set_path("/");
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

pub fn server_url<R: Runtime>(app: &AppHandle<R>) -> Option<Url> {
    load(app).url.as_deref().and_then(|u| normalize(u).ok())
}

/// What the main window should load right now.
pub fn main_url<R: Runtime>(app: &AppHandle<R>) -> WebviewUrl {
    match server_url(app) {
        Some(u) => WebviewUrl::External(u),
        None => WebviewUrl::App("index.html".into()),
    }
}

pub fn navigate_main<R: Runtime>(app: &AppHandle<R>, url: Url) -> Result<(), String> {
    let Some(w) = app.get_webview_window("main") else {
        return Err("no_main_window".into());
    };
    w.navigate(url).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_server_url<R: Runtime>(app: AppHandle<R>) -> Option<String> {
    server_url(&app).map(|u| u.to_string())
}

/// Validates, probes the API (`/api/auth/me` answers 401 JSON when signed
/// out — proof it is a Vibe appliance, unlike `/health` which the ingress
/// answers itself), persists, and navigates.
#[tauri::command]
pub async fn set_server_url<R: Runtime>(app: AppHandle<R>, url: String) -> Result<String, String> {
    let u = normalize(&url)?;
    let probe = u.join("api/auth/me").map_err(|e| e.to_string())?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(probe)
        .send()
        .await
        .map_err(|e| format!("unreachable: {e}"))?;
    let status = resp.status().as_u16();
    let json = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.contains("application/json"))
        .unwrap_or(false);
    if !(json && (status == 200 || status == 401)) {
        return Err(format!("not_a_vibe_server: HTTP {status}"));
    }
    save(
        &app,
        &ServerConfig {
            url: Some(u.to_string()),
        },
    )?;
    navigate_main(&app, u.clone())?;
    Ok(u.to_string())
}

/// Forget the server. The bundled connect page lives behind a platform-
/// specific custom-protocol origin, so rather than navigating to it we
/// restart: with no URL stored, the main window opens on the connect page.
#[tauri::command]
pub fn clear_server_url<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    save(&app, &ServerConfig::default())?;
    app.restart();
}
