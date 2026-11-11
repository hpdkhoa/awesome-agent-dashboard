//! Avatar per status (plan b73e97ad, step p7; the owner's picks, 2026-11-11: "Your files + built-in fallback",
//! config "All 3", 4th status "Yes, NEEDS YOU"). The badge shows one image per status. The images live in one folder,
//! %APPDATA%\agent-avatar\avatars, named in avatar.json there. Three ways set them: the right-click Avatar menu (pick a
//! file), a file dropped on the badge (asks which status), or editing avatar.json (reloads live). Picked and dropped
//! files are copied into the folder; only files inside the folder are ever read. A missing or broken file shows the
//! built-in robot (drawn by the page).

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{Map, Value};
use tauri::menu::{IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow, Wry};
use tauri_plugin_dialog::DialogExt;

pub const STATUSES: [(&str, &str); 4] =
    [("in_progress", "In progress"), ("done", "Done"), ("offline", "Offline"), ("needs_you", "Needs you")];
const MAX_BYTES: u64 = 20 * 1024 * 1024;
const EXTS: [&str; 8] = ["gif", "png", "apng", "webp", "jpg", "jpeg", "svg", "bmp"];

pub fn dir() -> PathBuf {
    // Windows: %APPDATA%; macOS (p12): ~/Library/Application Support, never the temp folder macOS empties
    #[cfg(target_os = "macos")]
    let base = std::env::var_os("HOME")
        .map(|h| PathBuf::from(h).join("Library").join("Application Support"))
        .unwrap_or_else(std::env::temp_dir);
    #[cfg(not(target_os = "macos"))]
    let base = std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    let d = base.join("agent-avatar").join("avatars");
    let _ = fs::create_dir_all(&d);
    d
}

fn cfg() -> Map<String, Value> {
    fs::read_to_string(dir().join("avatar.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(s.trim_start_matches('\u{feff}')).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

fn save(m: &Map<String, Value>) -> Result<(), String> {
    let text = serde_json::to_string_pretty(&Value::Object(m.clone())).map_err(|e| e.to_string())?;
    fs::write(dir().join("avatar.json"), text).map_err(|e| e.to_string())
}

fn mime(p: &Path) -> Option<&'static str> {
    let ext = p.extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "gif" => "image/gif",
        "png" | "apng" => "image/png",
        "webp" => "image/webp",
        "jpg" | "jpeg" => "image/jpeg",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        _ => return None,
    })
}

/// One file of the folder as its full path, for the page's file link (Tauri asset protocol, scoped to the avatar folder
/// only; p8 fix 5: no base64 copy in memory). Refuses a path that leaves the folder, a type that is not an image, a
/// file over 20 MB.
fn load(folder: &Path, name: &str) -> Result<(String, u64), String> {
    let p = folder.join(name).canonicalize().map_err(|_| "missing".to_string())?;
    if !p.starts_with(folder) {
        return Err("outside the avatar folder".into());
    }
    let m = mime(&p).ok_or("not an image type")?;
    if fs::metadata(&p).map_err(|e| e.to_string())?.len() > MAX_BYTES {
        return Err("over 20 MB".into());
    }
    let _ = m;
    // a swapped file under the same name gets a new link: its change time goes into the page's cache key
    let stamp = fs::metadata(&p).and_then(|md| md.modified()).ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0);
    let s = p.display().to_string();
    // canonicalize gives \\?\C:\...; the asset link wants the plain path
    Ok((s.strip_prefix(r"\\?\").unwrap_or(&s).to_string(), stamp))
}

/// The page asks for every status image: {in_progress: file path or null, ..., fit, stamp, errors: {status: why}, folder}.
#[tauri::command]
pub fn avatars() -> Value {
    let c = cfg();
    let folder = dir().canonicalize().unwrap_or_else(|_| dir());
    let mut out = Map::new();
    let mut errors = Map::new();
    let mut stamp = 0u64;
    for (k, _) in STATUSES {
        let v = match c.get(k).and_then(|v| v.as_str()) {
            Some(name) if !name.is_empty() => match load(&folder, name) {
                Ok((u, t)) => {
                    stamp = stamp.wrapping_add(t);
                    Value::String(u)
                }
                Err(e) => {
                    errors.insert(k.into(), Value::String(format!("{name}: {e}")));
                    Value::Null
                }
            },
            _ => Value::Null,
        };
        out.insert(k.into(), v);
    }
    let fit = c.get("fit").and_then(|v| v.as_str()).filter(|f| *f == "contain").unwrap_or("cover");
    out.insert("fit".into(), Value::String(fit.into()));
    out.insert("stamp".into(), Value::from(stamp));
    out.insert("errors".into(), Value::Object(errors));
    out.insert("folder".into(), Value::String(dir().display().to_string()));
    Value::Object(out)
}

/// Copies a picked or dropped image into the folder as <status>.<ext> and names it in avatar.json.
pub fn set(app: &AppHandle, status: &str, src: &Path) -> Result<(), String> {
    if !STATUSES.iter().any(|(k, _)| *k == status) {
        return Err("unknown status".into());
    }
    mime(src).ok_or("not an image type")?;
    if fs::metadata(src).map_err(|e| e.to_string())?.len() > MAX_BYTES {
        return Err("over 20 MB".into());
    }
    let ext = src.extension().and_then(|e| e.to_str()).unwrap_or("png").to_ascii_lowercase();
    let name = format!("{status}.{ext}");
    let dest = dir().join(&name);
    if src.canonicalize().ok() != dest.canonicalize().ok() {
        fs::copy(src, &dest).map_err(|e| e.to_string())?;
    }
    let mut c = cfg();
    c.insert(status.into(), Value::String(name));
    save(&c)?;
    let _ = app.emit("avatars", ());
    Ok(())
}

/// The right-click Avatar submenu: one item per status (its file or "robot"), the folder, the robot for all.
pub fn submenu(app: &AppHandle) -> tauri::Result<Submenu<Wry>> {
    let c = cfg();
    let mut items: Vec<MenuItem<Wry>> = Vec::new();
    for (k, label) in STATUSES {
        let now = c.get(k).and_then(|v| v.as_str()).filter(|s| !s.is_empty()).unwrap_or("robot");
        items.push(MenuItem::with_id(app, format!("avatar-{k}"), format!("{label}: {now}…"), true, None::<&str>)?);
    }
    let sep = PredefinedMenuItem::separator(app)?;
    let open = MenuItem::with_id(app, "avatar-open", "Open avatar folder", true, None::<&str>)?;
    let robot = MenuItem::with_id(app, "avatar-robot", "Use built-in robot", true, None::<&str>)?;
    let mut refs: Vec<&dyn IsMenuItem<Wry>> = items.iter().map(|i| i as &dyn IsMenuItem<Wry>).collect();
    refs.push(&sep);
    refs.push(&open);
    refs.push(&robot);
    Submenu::with_items(app, "Avatar", true, &refs)
}

/// A file dropped on the badge: kept here until the owner picks its status in the popup.
pub struct Pending(pub Mutex<Option<PathBuf>>);

#[tauri::command]
pub fn drop_ask(window: WebviewWindow, path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    mime(&p).ok_or("not an image type")?;
    let app = window.app_handle();
    *app.state::<Pending>().0.lock().unwrap() = Some(p.clone());
    let e = |e: tauri::Error| e.to_string();
    let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("file").to_string();
    let title = MenuItem::with_id(app, "drop-title", format!("Use {name} for:"), false, None::<&str>).map_err(e)?;
    let mut items: Vec<MenuItem<Wry>> = Vec::new();
    for (k, label) in STATUSES {
        items.push(MenuItem::with_id(app, format!("drop-{k}"), label, true, None::<&str>).map_err(e)?);
    }
    let cancel = MenuItem::with_id(app, "drop-cancel", "Cancel", true, None::<&str>).map_err(e)?;
    let sep = PredefinedMenuItem::separator(app).map_err(e)?;
    let mut refs: Vec<&dyn IsMenuItem<Wry>> = vec![&title, &sep];
    refs.extend(items.iter().map(|i| i as &dyn IsMenuItem<Wry>));
    refs.push(&cancel);
    let m = Menu::with_items(app, &refs).map_err(e)?;
    window.popup_menu(&m).map_err(e)
}

/// Menu ids of this module. Returns true when it handled the id.
pub fn on_menu(app: &AppHandle, id: &str) -> bool {
    if id == "avatar-open" {
        let _ = std::process::Command::new("explorer").arg(dir()).spawn();
    } else if id == "avatar-robot" {
        let mut c = cfg();
        for (k, _) in STATUSES {
            c.remove(k);
        }
        let _ = save(&c);
        let _ = app.emit("avatars", ());
    } else if let Some(k) = id.strip_prefix("avatar-") {
        let (app, k) = (app.clone(), k.to_string());
        std::thread::spawn(move || {
            let label = STATUSES.iter().find(|(s, _)| *s == k).map(|s| s.1).unwrap_or("");
            let picked = app
                .dialog()
                .file()
                .set_title(format!("Avatar for {label}"))
                .add_filter("Images", &EXTS)
                .set_directory(dir())
                .blocking_pick_file();
            if let Some(p) = picked.and_then(|f| f.into_path().ok()) {
                if let Err(e) = set(&app, &k, &p) {
                    let _ = app.emit("avatar-error", e);
                }
            }
        });
    } else if id == "drop-cancel" {
        *app.state::<Pending>().0.lock().unwrap() = None;
    } else if let Some(k) = id.strip_prefix("drop-") {
        let taken = app.state::<Pending>().0.lock().unwrap().take();
        if let Some(p) = taken {
            if let Err(e) = set(app, k, &p) {
                let _ = app.emit("avatar-error", e);
            }
        }
    } else {
        return false;
    }
    true
}

/// Watches the folder: an edit of avatar.json or a file swap reloads the badge.
pub fn watch(app: AppHandle) -> Option<notify::RecommendedWatcher> {
    use notify::{RecursiveMode, Watcher};
    let last = Mutex::new(Instant::now() - Duration::from_secs(1));
    let mut w = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if res.is_ok() {
            let mut t = last.lock().unwrap();
            if t.elapsed() > Duration::from_millis(300) {
                *t = Instant::now();
                let app = app.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(300)); // let the editor finish writing
                    let _ = app.emit("avatars", ());
                });
            }
        }
    })
    .ok()?;
    w.watch(&dir(), RecursiveMode::NonRecursive).ok()?;
    Some(w)
}
