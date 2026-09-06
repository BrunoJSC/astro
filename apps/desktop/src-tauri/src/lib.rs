/// The app's entry point, kept in the library rather than in `main.rs`.
///
/// `main.rs` is the desktop binary. A mobile target generates its own entry
/// point and links this crate, so anything that must run on every platform
/// belongs here -- not in `main`.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Opens URLs in the user's real browser instead of inside the app's
        // webview. OAuth depends on that: a provider's sign-in page rendered
        // in an embedded webview is both blocked by most providers and unable
        // to see an existing session.
        .plugin(tauri_plugin_shell::init())
        // Receives the `astro://` callback the browser hands back after a
        // social sign-in completes. The scheme is declared in tauri.conf.json;
        // the two have to agree or the redirect lands nowhere.
        .plugin(tauri_plugin_deep_link::init())
        // Persists the session token to a file the app owns, outside the
        // webview's storage. NOT encrypted -- see src/lib/storage/tauri-storage.ts
        // for why neither official plugin gives the OS keychain.
        .plugin(tauri_plugin_store::Builder::new().build())
        .invoke_handler(tauri::generate_handler![app_version])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Placeholder command, and the proof that the IPC bridge is wired.
///
/// Real domain logic does not belong here: the app talks to `apps/server`
/// over HTTP through Eden Treaty, which keeps one typed contract for web,
/// native and desktop. Commands are for what only a native process can do --
/// tray icons, notifications, global shortcuts, file dialogs.
#[tauri::command]
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
