fn main() {
    // Declare every #[tauri::command] in the app manifest so tauri-build
    // generates `allow-<command>` permissions for them. Without this the
    // remote-loaded staff app (practice.vcpa.app et al) cannot invoke ANY
    // app command: Tauri v2 gates IPC from remote URLs behind the ACL and
    // "Command X not allowed by ACL" is the failure the Settings page's
    // notification test surfaced. Keep in sync with generate_handler! in
    // src/lib.rs.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "list_capturable_windows",
            "capture_window",
            "set_tray_state",
            "set_close_to_tray",
            "show_main_window",
            "broadcast_timers_changed",
            "show_timer_widget",
            "timer_widget_visible",
            "toggle_timer_widget",
            "resize_timer_widget",
            "open_main_at",
            "set_favorites",
            "set_hotkeys",
            "set_idle_threshold",
            "set_foreground_watch",
            "notify",
            "set_badge",
            "clear_toasts",
            "test_notification",
            "secret_get",
            "secret_set",
            "secret_delete",
            "device_info",
            "app_version",
            "check_for_update",
            "install_update",
            "get_autostart",
            "set_autostart",
            "get_server_url",
            "set_server_url",
            "clear_server_url",
            "download_and_open",
            "open_external",
            "set_outbox_watch",
            "read_outbox_file",
            "delete_outbox_file",
        ]),
    ))
    .expect("failed to run tauri-build");
}
