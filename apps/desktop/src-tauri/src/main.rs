// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    vibe_desktop_lib::run();
}
