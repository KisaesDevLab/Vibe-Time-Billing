// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Native application menu (File / Timer / View / Help). Timer items reuse
// the tray's `tray:action` events so the web bridge handles both the same
// way; the rest emit `menu:action { kind }` or are handled here in Rust.

use serde::Serialize;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, Runtime};

#[derive(Serialize, Clone)]
struct MenuAction {
    kind: &'static str,
}

fn widget_visible<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.get_webview_window(crate::windows::TIMER_LABEL)
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false)
}

/// Rebuild the app menu (labels depend on window state).
pub fn refresh<R: Runtime>(app: &AppHandle<R>) {
    if let Ok(menu) = build(app) {
        let _ = app.set_menu(menu);
    }
}

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let file = Submenu::with_items(
        app,
        "&File",
        true,
        &[
            &MenuItem::with_id(
                app,
                "m:settings",
                "Desktop settings…",
                true,
                Some("CmdOrCtrl+,"),
            )?,
            &MenuItem::with_id(app, "m:change-server", "Change server…", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "m:hide", "Close to tray", true, Some("CmdOrCtrl+W"))?,
            &MenuItem::with_id(app, "m:quit", "Quit Vibe", true, Some("CmdOrCtrl+Q"))?,
        ],
    )?;
    let timer = Submenu::with_items(
        app,
        "&Timer",
        true,
        &[
            &MenuItem::with_id(app, "t:start", "Start timer…", true, None::<&str>)?,
            &MenuItem::with_id(app, "t:pause", "Pause running timer", true, None::<&str>)?,
            &MenuItem::with_id(app, "t:resume", "Resume last timer", true, None::<&str>)?,
            &MenuItem::with_id(app, "t:finish", "Finish on Time page…", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(
                app,
                "t:widget",
                if widget_visible(app) {
                    "Hide floating widget"
                } else {
                    "Show floating widget"
                },
                true,
                Some("CmdOrCtrl+Shift+W"),
            )?,
        ],
    )?;
    let view = Submenu::with_items(
        app,
        "&View",
        true,
        &[
            &MenuItem::with_id(app, "v:reload", "Reload", true, Some("F5"))?,
            &MenuItem::with_id(app, "v:zoom-in", "Zoom in", true, Some("CmdOrCtrl+="))?,
            &MenuItem::with_id(app, "v:zoom-out", "Zoom out", true, Some("CmdOrCtrl+-"))?,
            &MenuItem::with_id(
                app,
                "v:zoom-reset",
                "Actual size",
                true,
                Some("CmdOrCtrl+0"),
            )?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::fullscreen(app, Some("Toggle full screen"))?,
        ],
    )?;
    // Favorites — user-saved pages. Entries come from the web app
    // (`set_favorites`); ids are `f:<id>` so handle() can route them.
    let favorites = Submenu::with_items(
        app,
        "F&avorites",
        true,
        &[
            &MenuItem::with_id(
                app,
                "m:add-favorite",
                "Add current page to favorites…",
                true,
                Some("CmdOrCtrl+D"),
            )?,
            &MenuItem::with_id(
                app,
                "m:manage-favorites",
                "Manage favorites…",
                true,
                None::<&str>,
            )?,
        ],
    )?;
    let favs = app
        .state::<crate::state::AppState>()
        .favorites
        .lock()
        .map(|f| f.clone())
        .unwrap_or_default();
    if !favs.is_empty() {
        favorites.append(&PredefinedMenuItem::separator(app)?)?;
        for (i, f) in favs.iter().enumerate() {
            let accel = if i < 9 {
                Some(format!("CmdOrCtrl+{}", i + 1))
            } else {
                None
            };
            favorites.append(&MenuItem::with_id(
                app,
                format!("f:{}", f.id),
                &f.label,
                true,
                accel.as_deref(),
            )?)?;
        }
    }

    let help = Submenu::with_items(
        app,
        "&Help",
        true,
        &[
            &MenuItem::with_id(app, "h:help", "Help center", true, Some("F1"))?,
            &MenuItem::with_id(app, "h:update", "Check for updates…", true, None::<&str>)?,
            &MenuItem::with_id(
                app,
                "h:test-notify",
                "Send test notification",
                true,
                None::<&str>,
            )?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(
                app,
                "h:about",
                "About Vibe Practice Management",
                true,
                None::<&str>,
            )?,
        ],
    )?;
    Menu::with_items(app, &[&file, &timer, &favorites, &view, &help])
}

fn emit_menu<R: Runtime>(app: &AppHandle<R>, kind: &'static str) {
    crate::tray::show_main(app);
    let _ = app.emit("menu:action", MenuAction { kind });
    // Same belt-and-braces delivery as tray actions (see tray::emit_action).
    if let Some(w) = app.get_webview_window("main") {
        let js = format!(
            "window.dispatchEvent(new CustomEvent('vibe:desktop-menu',{{detail:{{kind:'{kind}',nonce:{}}}}}));",
            crate::state::now_ms()
        );
        let _ = w.eval(&js);
    }
}

fn zoom<R: Runtime>(app: &AppHandle<R>, delta: Option<f64>) {
    if let Some(w) = app.get_webview_window("main") {
        let js = match delta {
            None => "document.body.style.zoom='';".to_string(),
            Some(d) => format!(
                "(function(){{var z=parseFloat(document.body.style.zoom||'1');z=Math.min(2,Math.max(0.5,z+({d})));document.body.style.zoom=z;}})();"
            ),
        };
        let _ = w.eval(&js);
    }
}

pub fn handle<R: Runtime>(app: &AppHandle<R>, id: &str) {
    match id {
        "m:settings" => emit_menu(app, "settings"),
        "m:add-favorite" => emit_menu(app, "add-favorite"),
        "m:manage-favorites" => emit_menu(app, "manage-favorites"),
        "m:change-server" => emit_menu(app, "change-server"),
        "m:hide" => {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.hide();
            }
        }
        "m:quit" => {
            crate::files::purge_cache(app, true);
            app.exit(0);
        }
        "t:start" => crate::tray::emit_action(app, "start", None),
        "t:pause" => crate::tray::emit_action(app, "pause", None),
        "t:resume" => crate::tray::emit_action(app, "resume", None),
        "t:finish" => crate::tray::emit_action(app, "finish", None),
        "t:widget" => {
            let _ = crate::windows::toggle_timer_widget_impl(app);
        }
        "v:reload" => {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.eval("location.reload()");
            }
        }
        "v:zoom-in" => zoom(app, Some(0.1)),
        "v:zoom-out" => zoom(app, Some(-0.1)),
        "v:zoom-reset" => zoom(app, None),
        "h:help" => emit_menu(app, "help"),
        "h:update" => emit_menu(app, "check-update"),
        "h:test-notify" => {
            let _ = crate::notify::show_test_toast(app);
        }
        "h:about" => {
            let v = app.package_info().version.to_string();
            let _ = app.emit(
                "menu:about",
                serde_json::json!({ "version": v, "name": "Vibe Practice Management" }),
            );
            crate::tray::show_main(app);
        }
        other => {
            if let Some(fid) = other.strip_prefix("f:") {
                let path = app
                    .state::<crate::state::AppState>()
                    .favorites
                    .lock()
                    .ok()
                    .and_then(|f| f.iter().find(|x| x.id == fid).map(|x| x.path.clone()));
                if let Some(path) = path {
                    crate::tray::show_main(app);
                    let _ = app.emit("menu:navigate", serde_json::json!({ "path": path }));
                    if let Some(w) = app.get_webview_window("main") {
                        let js = format!(
                            "window.dispatchEvent(new CustomEvent('vibe:desktop-navigate',{{detail:{}}}));",
                            serde_json::json!({ "path": path, "nonce": crate::state::now_ms() })
                        );
                        let _ = w.eval(&js);
                    }
                }
            }
        }
    }
}

#[tauri::command]
pub fn set_favorites<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, crate::state::AppState>,
    favorites: Vec<crate::state::Favorite>,
) -> Result<(), String> {
    {
        let mut f = state.favorites.lock().map_err(|_| "state_poisoned")?;
        *f = favorites.into_iter().take(30).collect();
    }
    refresh(&app);
    Ok(())
}
