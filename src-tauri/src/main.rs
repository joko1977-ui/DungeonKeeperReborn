// The desktop shell is deliberately thin: the whole game is the web build, and
// Tauri only supplies a native window and a system WebView. That keeps one
// codebase behind the browser, desktop and mobile builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running Dungeon Keeper Reborn");
}
