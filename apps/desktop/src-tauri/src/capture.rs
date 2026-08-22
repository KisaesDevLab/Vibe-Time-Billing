// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Native window capture for "Capture Client Info". Two commands are exposed
// to the wrapped web app:
//   - list_capturable_windows() enumerates on-screen windows so the user can
//     pick the UltraTax CS window.
//   - capture_window(id) grabs that window as a PNG and returns it base64 so
//     the frontend can POST it to the local GLM-OCR endpoint. The bytes stay
//     in memory — nothing is written to disk — so no PII lingers on the box.
//
// Windows note: xcap uses GDI BitBlt, which works for conventional Win32
// apps like UltraTax CS but can return black frames for GPU-accelerated or
// occluded windows (e.g. under RDP/Citrix). Validate on the firm hardware;
// fall back to the print-to-PDF upload path when capture is black.

use base64::Engine;
use serde::Serialize;
use xcap::Window;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapturableWindow {
    id: u32,
    title: String,
    app_name: String,
    width: u32,
    height: u32,
}

#[tauri::command]
pub fn list_capturable_windows() -> Result<Vec<CapturableWindow>, String> {
    let wins = Window::all().map_err(|e| e.to_string())?;
    let out = wins
        .into_iter()
        .filter(|w| !w.is_minimized().unwrap_or(true))
        .map(|w| CapturableWindow {
            id: w.id().unwrap_or(0),
            title: w.title().unwrap_or_default(),
            app_name: w.app_name().unwrap_or_default(),
            width: w.width().unwrap_or(0),
            height: w.height().unwrap_or(0),
        })
        .filter(|w| w.width > 0 && w.height > 0)
        .collect();
    Ok(out)
}

#[tauri::command]
pub fn capture_window(id: u32) -> Result<String, String> {
    let win = Window::all()
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|w| w.id().unwrap_or(0) == id)
        .ok_or_else(|| "window_not_found".to_string())?;
    let img = win.capture_image().map_err(|e| e.to_string())?;
    let mut buf = std::io::Cursor::new(Vec::new());
    img.write_to(&mut buf, image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(buf.into_inner()))
}
