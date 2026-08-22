// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// DS-4 — file plumbing.
//
//   download_and_open   fetch a presigned URL into <app cache>/open/ and
//                       hand it to the OS default app. Cache entries are
//                       purged on quit and anything older than 24 h is
//                       purged on launch, so client documents do not
//                       accumulate on the workstation.
//   outbox              watch ~/VibeTB/Outbox for PDFs printed from
//                       UltraTax ("Microsoft Print to PDF" → that folder).
//                       When a file stops growing we emit
//                       `desktop:outbox-file`; the web dialog reads it via
//                       read_outbox_file (bytes, not base64) and asks us to
//                       delete it after upload. Both commands refuse any
//                       path outside the outbox.

use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use futures_util::StreamExt;
use notify::{EventKind, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::ipc::Response;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tauri_plugin_opener::OpenerExt;

use crate::state::AppState;

const CACHE_MAX_AGE: Duration = Duration::from_secs(24 * 3600);
const MAX_DOWNLOAD_BYTES: u64 = 512 * 1024 * 1024;
const MAX_OUTBOX_BYTES: u64 = 200 * 1024 * 1024;

fn cache_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("open");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn safe_filename(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\0' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.');
    if trimmed.is_empty() {
        "download".into()
    } else {
        trimmed.chars().take(150).collect()
    }
}

/// Remove cache entries; `all` on quit/update, otherwise only stale ones.
pub fn purge_cache<R: Runtime>(app: &AppHandle<R>, all: bool) {
    let Ok(dir) = cache_dir(app) else { return };
    let Ok(rd) = std::fs::read_dir(&dir) else {
        return;
    };
    let now = SystemTime::now();
    for entry in rd.flatten() {
        let p = entry.path();
        let stale = entry
            .metadata()
            .and_then(|m| m.modified())
            .map(|t| now.duration_since(t).unwrap_or(Duration::ZERO) > CACHE_MAX_AGE)
            .unwrap_or(true);
        if all || stale {
            let _ = std::fs::remove_file(&p);
        }
    }
}

#[tauri::command]
pub async fn download_and_open<R: Runtime>(
    app: AppHandle<R>,
    url: String,
    filename: String,
) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("unsupported_url".into());
    }
    let dir = cache_dir(&app)?;
    // Unique per download so two files with the same name never collide.
    let stamp = crate::state::now_ms();
    let target = dir.join(format!("{stamp}-{}", safe_filename(&filename)));

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(300))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    if let Some(len) = resp.content_length() {
        if len > MAX_DOWNLOAD_BYTES {
            return Err("file_too_large".into());
        }
    }
    let mut file = tokio::fs::File::create(&target)
        .await
        .map_err(|e| e.to_string())?;
    let mut stream = resp.bytes_stream();
    let mut total: u64 = 0;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        total += chunk.len() as u64;
        if total > MAX_DOWNLOAD_BYTES {
            let _ = tokio::fs::remove_file(&target).await;
            return Err("file_too_large".into());
        }
        tokio::io::AsyncWriteExt::write_all(&mut file, &chunk)
            .await
            .map_err(|e| e.to_string())?;
    }
    tokio::io::AsyncWriteExt::flush(&mut file)
        .await
        .map_err(|e| e.to_string())?;
    drop(file);

    app.opener()
        .open_path(target.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_external<R: Runtime>(app: AppHandle<R>, url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://") || url.starts_with("mailto:")) {
        return Err("unsupported_url".into());
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

// ---- outbox -------------------------------------------------------------------

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct OutboxFile {
    path: String,
    name: String,
    size: u64,
}

pub struct OutboxWatcher(pub Mutex<Option<notify::RecommendedWatcher>>);

pub fn outbox_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    let dir = home.join("VibeTB").join("Outbox");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn inside_outbox(dir: &Path, p: &Path) -> bool {
    match (dir.canonicalize(), p.canonicalize()) {
        (Ok(d), Ok(f)) => f.starts_with(&d) && f.is_file(),
        _ => false,
    }
}

fn is_pdf(p: &Path) -> bool {
    p.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("pdf"))
        .unwrap_or(false)
}

/// Wait until the file stops growing (print spoolers write in bursts).
fn settle(p: &Path) -> Option<u64> {
    let mut last: Option<u64> = None;
    for _ in 0..40 {
        std::thread::sleep(Duration::from_millis(500));
        let size = std::fs::metadata(p).ok()?.len();
        if size > 0 && last == Some(size) {
            // One more check that the writer has released the handle.
            if std::fs::OpenOptions::new().read(true).open(p).is_ok() {
                return Some(size);
            }
        }
        last = Some(size);
    }
    last.filter(|s| *s > 0)
}

fn announce<R: Runtime>(app: &AppHandle<R>, p: PathBuf) {
    let handle = app.clone();
    std::thread::spawn(move || {
        if let Some(size) = settle(&p) {
            if size > MAX_OUTBOX_BYTES {
                return;
            }
            let _ = handle.emit(
                "desktop:outbox-file",
                OutboxFile {
                    path: p.to_string_lossy().to_string(),
                    name: p
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_default(),
                    size,
                },
            );
        }
    });
}

#[tauri::command]
pub fn set_outbox_watch<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    watcher: State<'_, OutboxWatcher>,
    enabled: bool,
) -> Result<String, String> {
    let dir = outbox_dir(&app)?;
    state.outbox_watch.store(enabled, Ordering::Relaxed);
    let mut slot = watcher.0.lock().map_err(|_| "watcher_poisoned")?;
    if !enabled {
        *slot = None;
        return Ok(dir.to_string_lossy().to_string());
    }
    if slot.is_some() {
        return Ok(dir.to_string_lossy().to_string());
    }
    let handle = app.clone();
    let announced = std::sync::Arc::new(Mutex::new(std::collections::HashSet::<PathBuf>::new()));
    let mut w = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(ev) = res else { return };
        if !matches!(ev.kind, EventKind::Create(_) | EventKind::Modify(_)) {
            return;
        }
        for p in ev.paths {
            if !is_pdf(&p) {
                continue;
            }
            let fresh = announced
                .lock()
                .map(|mut s| s.insert(p.clone()))
                .unwrap_or(false);
            if fresh {
                // Forget it after a while so a re-printed same-named file
                // is announced again.
                let set = announced.clone();
                let key = p.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_secs(120));
                    if let Ok(mut s) = set.lock() {
                        s.remove(&key);
                    }
                });
                announce(&handle, p);
            }
        }
    })
    .map_err(|e| e.to_string())?;
    w.watch(&dir, RecursiveMode::NonRecursive)
        .map_err(|e| e.to_string())?;
    *slot = Some(w);

    // Anything already sitting in the folder (printed while the app was
    // closed) is announced too.
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.flatten() {
            let p = e.path();
            if is_pdf(&p) {
                announce(&app, p);
            }
        }
    }
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
pub fn read_outbox_file<R: Runtime>(app: AppHandle<R>, path: String) -> Result<Response, String> {
    let dir = outbox_dir(&app)?;
    let p = PathBuf::from(&path);
    if !inside_outbox(&dir, &p) {
        return Err("outside_outbox".into());
    }
    let meta = std::fs::metadata(&p).map_err(|e| e.to_string())?;
    if meta.len() > MAX_OUTBOX_BYTES {
        return Err("file_too_large".into());
    }
    let bytes = std::fs::read(&p).map_err(|e| e.to_string())?;
    Ok(Response::new(bytes))
}

#[tauri::command]
pub fn delete_outbox_file<R: Runtime>(app: AppHandle<R>, path: String) -> Result<(), String> {
    let dir = outbox_dir(&app)?;
    let p = PathBuf::from(&path);
    if !inside_outbox(&dir, &p) {
        return Err("outside_outbox".into());
    }
    std::fs::remove_file(&p).map_err(|e| e.to_string())
}
