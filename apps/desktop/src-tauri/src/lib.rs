// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Vibe Time & Billing desktop shell. Thin Tauri 2 wrapper around the staff
// web app that adds what a browser tab cannot:
//
//   capture.rs   native window capture for Capture Client Info (original)
//   tray.rs      tray icon + menu mirroring the server-side timers  (DS-1)
//   windows.rs   always-on-top mini timer window                    (DS-1)
//   hotkeys.rs   global shortcuts                                    (DS-1)
//   watchers.rs  idle detection, foreground-window (opt-in)         (DS-1)
//   notify.rs    native toasts with click-through, badge            (DS-2)
//   secrets.rs   OS credential store + device id                    (DS-3)
//   rollout.rs   auto-update, autostart                             (DS-3)
//   files.rs     download-and-open cache, print-to-PDF outbox       (DS-4)
//
// Contract with the web app: apps/web/src/lib/desktop.ts (command names,
// argument shapes, event names). Keep the two in step.

mod capture;
mod files;
mod hotkeys;
mod notify;
mod rollout;
mod secrets;
mod server;
mod state;
mod tray;
mod watchers;
mod windows;

use std::sync::atomic::Ordering;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{Emitter, Manager, RunEvent, WindowEvent};
use tauri_plugin_deep_link::DeepLinkExt;

use state::AppState;

#[derive(Serialize, Clone)]
struct DeepLinkPayload {
    url: String,
}

fn forward_deep_links<R: tauri::Runtime>(app: &tauri::AppHandle<R>, urls: &[String]) {
    for u in urls {
        if u.to_ascii_lowercase().starts_with("vibetb://") {
            tray::show_main(app);
            let _ = app.emit("desktop:deep-link", DeepLinkPayload { url: u.clone() });
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        // Must be first: a second launch (double-clicked shortcut, a
        // vibetb:// link) hands its args to the running instance and exits.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            tray::show_main(app);
            forward_deep_links(app, &args);
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--hidden"]),
        ))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        // Remembers size/position of every window (main + timer widget).
        // VISIBLE is excluded on purpose: a main window closed to the tray
        // must still appear on the next launch.
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::all()
                        & !tauri_plugin_window_state::StateFlags::VISIBLE,
                )
                .build(),
        )
        .manage(AppState::default())
        .manage(files::OutboxWatcher(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            // capture
            capture::list_capturable_windows,
            capture::capture_window,
            // tray / windows
            tray::set_tray_state,
            tray::set_close_to_tray,
            tray::show_main_window,
            tray::broadcast_timers_changed,
            windows::show_timer_widget,
            // hotkeys + watchers
            hotkeys::set_hotkeys,
            watchers::set_idle_threshold,
            watchers::set_foreground_watch,
            // notifications
            notify::notify,
            notify::set_badge,
            notify::clear_toasts,
            // secrets / identity
            secrets::secret_get,
            secrets::secret_set,
            secrets::secret_delete,
            secrets::device_info,
            secrets::app_version,
            // rollout
            rollout::check_for_update,
            rollout::install_update,
            rollout::get_autostart,
            rollout::set_autostart,
            // server
            server::get_server_url,
            server::set_server_url,
            server::clear_server_url,
            // files
            files::download_and_open,
            files::open_external,
            files::set_outbox_watch,
            files::read_outbox_file,
            files::delete_outbox_file,
        ])
        .setup(|app| {
            let handle = app.handle().clone();

            // The main window is created here, not in tauri.conf.json, so it
            // can load either the remote staff app (server configured) or
            // the bundled connect page (first launch).
            let hidden = std::env::args().any(|a| a == "--hidden");
            tauri::WebviewWindowBuilder::new(app, "main", server::main_url(&handle))
                .title("Vibe Time & Billing")
                .inner_size(1440.0, 900.0)
                .min_inner_size(960.0, 600.0)
                .resizable(true)
                // Leave HTML5 drag-and-drop to the web app (Files tab,
                // request items); Tauri's native handler would swallow it.
                .disable_drag_drop_handler()
                .visible(!hidden)
                .build()?;

            // Deep links: register the scheme at runtime too (dev builds
            // have no installer to do it) and forward opens to the webview.
            #[cfg(any(windows, target_os = "linux"))]
            {
                let _ = app.deep_link().register_all();
            }
            let h = handle.clone();
            app.deep_link().on_open_url(move |event| {
                let urls: Vec<String> = event.urls().iter().map(|u| u.to_string()).collect();
                forward_deep_links(&h, &urls);
            });

            tray::build_tray(&handle)?;
            watchers::spawn_idle_watcher(handle.clone());
            watchers::spawn_foreground_watcher(handle.clone());
            rollout::spawn_update_checker(handle.clone());
            files::purge_cache(&handle, false);

            // Close → tray (unless the user turned that off).
            if let Some(main) = app.get_webview_window("main") {
                let h = handle.clone();
                let win = main.clone();
                main.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        if h.state::<AppState>().close_to_tray.load(Ordering::Relaxed) {
                            api.prevent_close();
                            let _ = win.hide();
                        }
                    }
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app, event| {
        if let RunEvent::Exit = event {
            files::purge_cache(app, true);
        }
    });
}
