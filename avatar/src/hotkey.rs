//! plan c5cb9485 s5, (d) the hotkey composer. The owner's pick (round 2, "Hotkey (d)"): "Set in menu": right click >
//! Hotkey, press any key combo. One global key, kept in %APPDATA%\agent-avatar\hotkey.txt (macOS: Application Support),
//! opens node 3 (the SEND box) at the avatar, with any app in front. A combo the system or another app already holds is
//! refused (the OS refuses to register it) and the old key stays.
use std::{fs, path::PathBuf, sync::Mutex};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

static NOW: Mutex<Option<Shortcut>> = Mutex::new(None);

fn file() -> PathBuf {
    let d = crate::avatar::dir();
    d.parent().map(|p| p.to_path_buf()).unwrap_or(d).join("hotkey.txt")
}

/// the saved combo as the owner set it ("" = none)
pub fn saved() -> String {
    fs::read_to_string(file()).map(|s| s.trim().to_string()).unwrap_or_default()
}

pub fn plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, _sc, ev| {
            if ev.state() == ShortcutState::Pressed {
                open(app);
            }
        })
        .build()
}

/// at start: the saved key, if any; a key taken since then shows on the avatar
pub fn start<R: Runtime>(app: &AppHandle<R>) {
    let k = saved();
    if k.is_empty() {
        return;
    }
    match k.parse::<Shortcut>() {
        Ok(sc) if app.global_shortcut().register(sc).is_ok() => *NOW.lock().unwrap() = Some(sc),
        _ => {
            let _ = app.emit_to("main", "hotkey-error", format!("{k} is taken by another app: right click > Hotkey to pick another"));
        }
    }
}

// the key: the avatar shows (always on top), takes the focus and opens node 3
fn open<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_always_on_top(true);
        let _ = w.set_focus();
    }
    let _ = app.emit_to("main", "hotkey", ());
}

#[tauri::command]
pub fn hotkey_get() -> String {
    saved()
}

/// combo "" clears the key. Else: it needs a modifier and a key; it is registered first, and only then the old key is
/// let go and the new one saved, so a refused combo changes nothing.
#[tauri::command]
pub fn hotkey_set(app: AppHandle, combo: String) -> Result<String, String> {
    let gs = app.global_shortcut();
    let mut now = NOW.lock().unwrap();
    if combo.is_empty() {
        if let Some(old) = now.take() {
            let _ = gs.unregister(old);
        }
        let _ = fs::remove_file(file());
        return Ok(String::new());
    }
    let sc: Shortcut = combo.parse().map_err(|e| format!("{combo} is not a key combo ({e})"))?;
    if sc.mods.is_empty() {
        return Err("add Ctrl, Alt, Shift or Win to the key".to_string());
    }
    if *now != Some(sc) {
        gs.register(sc).map_err(|_| format!("{combo} is taken by another app or the system: pick another"))?;
        if let Some(old) = now.replace(sc) {
            let _ = gs.unregister(old);
        }
    }
    fs::write(file(), &combo).map_err(|e| e.to_string())?;
    Ok(combo)
}
