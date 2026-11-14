//! The desktop avatar (plan b73e97ad, step p3): a frameless, always-on-top box that shows the bridge's /status
//! (127.0.0.1:8794, bridge/agent_bridge/status.py) and this PC's CPU, RAM and GPU. Drag anywhere to move; the
//! position is kept. Right click or the tray icon: hide, show, quit. OFFLINE when /status does not answer.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod auth;
mod avatar;
mod hotkey;
mod voice;

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow, WindowEvent};
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

const STATUS_PORT: u16 = 8794;

/// GET /status from the bridge on this PC, from the Rust side (no CORS, the Host header the bridge asks for).
fn fetch_status() -> Result<String, String> {
    let addr = SocketAddr::from(([127, 0, 0, 1], STATUS_PORT));
    let mut s = TcpStream::connect_timeout(&addr, Duration::from_secs(2)).map_err(|e| e.to_string())?;
    s.set_read_timeout(Some(Duration::from_secs(8))).ok();
    write!(s, "GET /status HTTP/1.1\r\nHost: 127.0.0.1:{STATUS_PORT}\r\nConnection: close\r\n\r\n")
        .map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    s.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&buf);
    let (head, body) = text.split_once("\r\n\r\n").ok_or("no answer body")?;
    let first = head.lines().next().unwrap_or("");
    if !first.contains(" 200 ") {
        return Err(first.to_string());
    }
    Ok(body.to_string())
}

#[tauri::command]
async fn status() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(fetch_status).await.map_err(|e| e.to_string())?
}

// Button 2 RATES (plan b73e97ad p15; the owner's words, 2026-11-11: "I want the second button is my rate board, only need
// gold bar (SJC), USD (vietcombank and hsbc), change rate calculated from last sync and a sync button"). The page asks
// the dashboard Worker's routes, the same ones the Rates tab uses (worker/index.ts, 5-minute cache). The Worker sends no
// CORS header, so the page cannot ask it itself; this asks from the Rust side, these three paths only.
const SITE: &str = "https://agent.500kv.co";
const PRICE_PATHS: [&str; 3] = ["/api/fx/vcb", "/api/fx/hsbc", "/api/gold/giavang"];

fn fetch_price(path: &str) -> Result<String, String> {
    let site = std::env::var("AGENT_SITE").unwrap_or_else(|_| SITE.to_string());
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(20)))
        .http_status_as_error(false)
        .build()
        .into();
    let mut r = agent.get(&format!("{site}{path}")).header("Cache-Control", "no-store").call().map_err(|e| e.to_string())?;
    let code = r.status().as_u16();
    let body = r.body_mut().read_to_string().map_err(|e| e.to_string())?;
    if code >= 400 {
        // the Worker's own reason ({"error": "..."}), else the status
        let why = serde_json::from_str::<serde_json::Value>(&body).ok()
            .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(str::to_string));
        return Err(why.unwrap_or_else(|| format!("sync failed ({code})")));
    }
    Ok(body)
}

#[tauri::command]
async fn price(path: String) -> Result<String, String> {
    if !PRICE_PATHS.contains(&path.as_str()) {
        return Err(format!("{path} is not a rate route"));
    }
    tauri::async_runtime::spawn_blocking(move || fetch_price(&path)).await.map_err(|e| e.to_string())?
}

// The boxes' bridges (the owner's words, 2026-11-13: "Change the avatar to read the bridge"): each box keeps its own
// data and answers POST <its address>/data (bridge dataapi.py) for the owner's sign-in. The page cannot ask a box
// itself (its content policy names fixed hosts, and a box's address is the owner's own), so this asks from the Rust
// side: https addresses only (or this PC), the data route only, reads only; the writes are the SEND box's new command
// and the NEEDS YOU deck's answer (s4, is_answer).
// s3: also POST /text, reads only: {"run": id} (a finished run's reply) or {"live": id} (the running turn so far).
fn post_box(url: &str, token: &str, body: &str, route: &str) -> Result<String, String> {
    let url = url.trim_end_matches("/");
    if !(url.starts_with("https://") || url.starts_with("http://127.0.0.1:")) {
        return Err("a box address must be https".to_string());
    }
    let v: serde_json::Value = serde_json::from_str(body).map_err(|e| e.to_string())?;
    if route == "text" {
        if !is_run_text(&v) {
            return Err("only a run's text".to_string());
        }
    } else if route == "ticket" {
        // s4: a ticket for one picture of an ask (fetch_picture); {path, cwd} only
        let o = v.as_object().ok_or("not a ticket ask")?;
        if o.len() != 2 || !o.get("path").is_some_and(|x| x.is_string()) || !o.get("cwd").is_some_and(|x| x.is_string()) {
            return Err("only a picture's ticket".to_string());
        }
    } else {
        let op = v.get("op").and_then(|o| o.as_str()).unwrap_or("");
        if !["find", "get", "count", "seq", "changes", "env_keys"].contains(&op) && !is_send(&v) && !is_answer(&v) && !is_env_set(&v) {
            return Err(format!("{op} is not a read"));
        }
    }
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(35)))
        .http_status_as_error(false)
        .build()
        .into();
    let mut r = agent.post(&format!("{url}/{route}"))
        .header("Authorization", &format!("Bearer {token}"))
        .header("Content-Type", "application/json")
        .header("User-Agent", "agent-avatar")
        .send(body)
        .map_err(|e| e.to_string())?;
    let code = r.status().as_u16();
    let text = r.body_mut().read_to_string().map_err(|e| e.to_string())?;
    if code >= 400 {
        return Err(format!("the box answered {code}"));
    }
    Ok(text)
}

// plan c5cb9485 s2: the only write a box takes from the avatar: one new start or message command (s9: or search), set (not merged) at
// commands/<its own id>, status "new". Anything else stays refused.
fn is_send(v: &serde_json::Value) -> bool {
    let s = |o: &serde_json::Value, k: &str| o.get(k).and_then(|x| x.as_str()).map(str::to_string);
    let (Some(path), Some(d)) = (s(v, "path"), v.get("data")) else { return false };
    let id = s(d, "id").unwrap_or_default();
    s(v, "op").as_deref() == Some("set")
        && v.get("merge").map_or(true, |m| m == &serde_json::Value::Bool(false))
        && !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric())
        && path == format!("commands/{id}")
        && s(d, "status").as_deref() == Some("new")
        && matches!(s(d, "action").as_deref(), Some("start") | Some("message") | Some("search"))
}

// plan c5cb9485 s10: the CONFIG box's one write: one allow-listed key into the box's .env ({op, name, value} and nothing
// else); the bridge checks the value and backs up the old .env (dataapi.py env_set). env_keys (masked) is a read.
const ENV_KEYS: [&str; 1] = ["GEMINI_API_KEY"];
fn is_env_set(v: &serde_json::Value) -> bool {
    let Some(o) = v.as_object() else { return false };
    o.len() == 3
        && o.get("op").and_then(|x| x.as_str()) == Some("env_set")
        && o.get("name").and_then(|x| x.as_str()).is_some_and(|n| ENV_KEYS.contains(&n))
        && o.get("value").and_then(|x| x.as_str()).is_some_and(|x| (8..=200).contains(&x.len()))
}

// plan c5cb9485 s4: the NEEDS YOU deck's one write: an update of one inbox record with the fields the page writes when
// the owner answers (web/src/data.ts answerItem, saveDraft): status "answered" with its answer, error null, the saved
// draft and the thread. Nothing else in the record, no other record.
const ANSWER_FIELDS: [&str; 5] = ["status", "answer", "error", "draft", "thread"];
fn is_answer(v: &serde_json::Value) -> bool {
    let s = |o: &serde_json::Value, k: &str| o.get(k).and_then(|x| x.as_str()).map(str::to_string);
    let (Some(path), Some(f)) = (s(v, "path"), v.get("fields").and_then(|f| f.as_object())) else { return false };
    let id = path.strip_prefix("inbox/").unwrap_or("");
    s(v, "op").as_deref() == Some("update")
        && !id.is_empty() && id.len() <= 40 && id.chars().all(|c| c.is_ascii_alphanumeric())
        && !f.is_empty() && f.keys().all(|k| ANSWER_FIELDS.contains(&k.as_str()))
        && f.get("status").map_or(true, |x| x == "answered" && f.get("answer").is_some_and(|a| a.is_object()))
        && f.get("error").map_or(true, |x| x.is_null())
}

// s4: a picture of an ask, from the box that asked: its /ticket (the same route and lock as the page's file viewer),
// then the file's bytes, handed to the page as a data URL (the window's content policy takes data: images only).
// Images only, 8 MB at most; nothing is kept on disk.
const PIC_MAX: usize = 8 * 1024 * 1024;
fn pic_type(path: &str) -> Option<&'static str> {
    let ext = path.rsplit('.').next()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "png" => "image/png", "jpg" | "jpeg" => "image/jpeg", "gif" => "image/gif", "webp" => "image/webp",
        "svg" => "image/svg+xml", "bmp" => "image/bmp", "avif" => "image/avif", _ => return None,
    })
}
fn b64(data: &[u8]) -> String {
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for c in data.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            out.push(if i <= c.len() { A[(n >> (18 - 6 * i) & 63) as usize] as char } else { '=' });
        }
    }
    out
}
fn fetch_picture(url: &str, token: &str, path: &str, cwd: &str) -> Result<String, String> {
    let mime = pic_type(path).ok_or("not a picture")?;
    let body = serde_json::json!({"path": path, "cwd": cwd}).to_string();
    let t: serde_json::Value = serde_json::from_str(&post_box(url, token, &body, "ticket")?).map_err(|e| e.to_string())?;
    let rel = t.get("url").and_then(|x| x.as_str()).unwrap_or("");
    if !rel.starts_with("/t/") || t.get("kind").and_then(|x| x.as_str()) != Some("image") {
        return Err("the box has no such picture".to_string());
    }
    if t.get("size").and_then(|x| x.as_u64()).unwrap_or(u64::MAX) > PIC_MAX as u64 {
        return Err("picture over 8 MB".to_string());
    }
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(35)))
        .build()
        .into();
    let mut r = agent.get(&format!("{}{rel}", url.trim_end_matches('/'))).header("User-Agent", "agent-avatar").call()
        .map_err(|e| e.to_string())?;
    let bytes = r.body_mut().with_config().limit(PIC_MAX as u64).read_to_vec().map_err(|e| e.to_string())?;
    Ok(format!("data:{mime};base64,{}", b64(&bytes)))
}

#[tauri::command]
async fn box_picture(url: String, token: String, path: String, cwd: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || fetch_picture(&url, &token, &path, &cwd)).await.map_err(|e| e.to_string())?
}

// s3: {"run": id} or {"live": id}, one key, the run id letters and digits only
fn is_run_text(v: &serde_json::Value) -> bool {
    let Some(o) = v.as_object() else { return false };
    o.len() == 1 && ["run", "live"].iter().any(|k| o.get(*k).and_then(|x| x.as_str())
        .is_some_and(|id| !id.is_empty() && id.len() <= 40 && id.chars().all(|c| c.is_ascii_alphanumeric())))
}

#[tauri::command]
async fn box_data(url: String, token: String, body: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || post_box(&url, &token, &body, "data")).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn box_text(url: String, token: String, body: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || post_box(&url, &token, &body, "text")).await.map_err(|e| e.to_string())?
}

// s3 "Open on dashboard": the run's page on the dashboard site in the default browser (the run id: letters and digits)
#[tauri::command]
fn open_run(id: String) -> Result<(), String> {
    open_site("run", &id)
}

// s4 "Open on dashboard" on an ask: the inbox item's page (the page reads ?item=<id>)
#[tauri::command]
fn open_item(id: String) -> Result<(), String> {
    open_site("item", &id)
}

fn open_site(key: &str, id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 40 || !id.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(format!("not a {key} id"));
    }
    let url = format!("{SITE}/?{key}={id}");
    #[cfg(target_os = "windows")]
    let r = std::process::Command::new("rundll32").args(["url.dll,FileProtocolHandler", &url]).spawn();
    #[cfg(target_os = "macos")]
    let r = std::process::Command::new("open").arg(&url).spawn();
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let r = std::process::Command::new("xdg-open").arg(&url).spawn();
    r.map(|_| ()).map_err(|e| e.to_string())
}

struct Load {
    sys: Mutex<Option<sysinfo::System>>, // None when sysinfo cannot start on this machine
    nvml: Option<nvml_wrapper::Nvml>,
}

#[tauri::command]
fn load(st: tauri::State<'_, Load>) -> serde_json::Value {
    let (cpu, ram) = match st.sys.lock().unwrap().as_mut() {
        Some(sys) => {
            sys.refresh_cpu_usage();
            sys.refresh_memory();
            let total = sys.total_memory().max(1) as f64;
            (Some((sys.global_cpu_usage() as f64).round()), Some((sys.used_memory() as f64 / total * 100.0).round()))
        }
        None => (None, None),
    };
    let gpu = st
        .nvml
        .as_ref()
        .and_then(|n| n.device_by_index(0).ok())
        .and_then(|d| d.utilization_rates().ok())
        .map(|u| u.gpu);
    serde_json::json!({ "cpu": cpu, "ram": ram, "gpu": gpu })
}

/// The box sizes in the right-click menu (the owner's pick, 2026-11-11: "S M L XL").
const SIZES: [(&str, &str, f64); 4] = [("size-80", "S  80%", 0.8), ("size-100", "M  100%", 1.0),
    ("size-130", "L  130%", 1.3), ("size-160", "XL  160%", 1.6)];

/// The right-click menu on the box: Size (a tick on the current zoom), Avatar, Follow (p11: All or one bridge, a tick
/// on the current pick), Sign in / Sign out (p11, only when firebase.json is set up), Hide, Quit.
#[tauri::command]
fn menu(window: WebviewWindow, zoom: f64, bridges: Option<Vec<String>>, follow: Option<String>, signed: Option<bool>)
    -> Result<(), String> {
    let e = |e: tauri::Error| e.to_string();
    let app = window.app_handle();
    let mut items = Vec::new();
    for (id, label, z) in SIZES {
        items.push(CheckMenuItem::with_id(app, id, label, true, (zoom - z).abs() < 0.01, None::<&str>).map_err(e)?);
    }
    let refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> = items.iter().map(|i| i as _).collect();
    let size = Submenu::with_items(app, "Size", true, &refs).map_err(e)?;
    let hide = MenuItem::with_id(app, "hide", "Hide", true, None::<&str>).map_err(e)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>).map_err(e)?;
    let av = avatar::submenu(app).map_err(e)?;
    let sep = PredefinedMenuItem::separator(app).map_err(e)?;
    let follow = follow.unwrap_or_else(|| "all".into());
    let mut fitems = vec![CheckMenuItem::with_id(app, "follow:all", "All bridges", true, follow == "all", None::<&str>).map_err(e)?];
    for b in bridges.unwrap_or_default() {
        fitems.push(CheckMenuItem::with_id(app, format!("follow:{b}"), &b, true, follow == b, None::<&str>).map_err(e)?);
    }
    let frefs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> = fitems.iter().map(|i| i as _).collect();
    let fol = Submenu::with_items(app, "Follow", true, &frefs).map_err(e)?;
    let has_cfg = auth::config().is_some();
    let sign = if signed.unwrap_or(false) {
        MenuItem::with_id(app, "signout", "Sign out", true, None::<&str>).map_err(e)?
    } else {
        MenuItem::with_id(app, "signin", "Sign in with Google…", has_cfg, None::<&str>).map_err(e)?
    };
    let sep2 = PredefinedMenuItem::separator(app).map_err(e)?;
    // s5: the hotkey composer's key, set here (the owner's pick "Set in menu")
    let k = hotkey::saved();
    let hk = MenuItem::with_id(app, "hotkey", format!("Hotkey: {}…", if k.is_empty() { "none" } else { &k }), true, None::<&str>).map_err(e)?;
    let m = Menu::with_items(app, &[&size, &av, &fol, &hk, &sep2, &sign, &sep, &hide, &quit]).map_err(e)?;
    window.popup_menu(&m).map_err(e)
}

fn toggle(app: &AppHandle, show: Option<bool>) {
    if let Some(w) = app.get_webview_window("main") {
        let visible = w.is_visible().unwrap_or(true);
        if show.unwrap_or(!visible) {
            let _ = w.show();
            let _ = w.set_always_on_top(true);
        } else {
            let _ = w.hide();
        }
    }
}

fn quit(app: &AppHandle) {
    let _ = app.save_window_state(StateFlags::POSITION);
    app.exit(0);
}

fn main() {
    let mut sys = sysinfo::System::new().ok();
    if let Some(s) = sys.as_mut() {
        s.refresh_cpu_usage(); // the first CPU reading needs an earlier one
    }
    let last_save = Mutex::new(Instant::now() - Duration::from_secs(10));
    tauri::Builder::default()
        // one avatar only: a second start (sign-in task, a click on the exe) shows the one already running
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| toggle(app, Some(true))))
        .plugin(tauri_plugin_window_state::Builder::default().with_state_flags(StateFlags::POSITION).build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(hotkey::plugin())   // s5: the global key that opens node 3
        .manage(voice::Voice::default())   // s6: the voice toggle
        .manage(Load { sys: Mutex::new(sys), nvml: nvml_wrapper::Nvml::init().ok() })
        .manage(avatar::Pending(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![status, load, price, box_data, box_text, box_picture, open_run, open_item, hotkey::hotkey_get, hotkey::hotkey_set, voice::voice_start, voice::voice_stop, voice::voice_on, menu, avatar::avatars, avatar::drop_ask, auth::fb_config,
            auth::auth_get, auth::auth_set])
        .on_menu_event(|app, e| match e.id().as_ref() {
            "hide" => toggle(app, Some(false)),
            "show" => toggle(app, Some(true)),
            "quit" => quit(app),
            "signin" => auth::sign_in(app.clone()),
            "hotkey" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.set_focus();   // the key box takes the keys
                }
                let _ = app.emit_to("main", "hotkey-capture", hotkey::saved());
            }
            "signout" => {
                auth::clear();
                let _ = app.emit_to("main", "signout", ());
            }
            id if id.starts_with("follow:") => {
                let _ = app.emit_to("main", "follow", id.trim_start_matches("follow:").to_string());
            }
            id if avatar::on_menu(app, id) => {}
            id => {
                // a Size pick: the page applies it (one zoom value for corner, menu and Ctrl+wheel)
                if let Some((_, _, z)) = SIZES.iter().find(|(i, _, _)| *i == id) {
                    let _ = app.emit_to("main", "zoom", *z);
                }
            }
        })
        .on_window_event(move |w, e| {
            // keep the position after every drag (at most twice a second), so a reboot keeps it too
            if let WindowEvent::Moved(_) = e {
                let mut t = last_save.lock().unwrap();
                if t.elapsed() > Duration::from_millis(500) {
                    *t = Instant::now();
                    let _ = w.app_handle().save_window_state(StateFlags::POSITION);
                }
            }
            if let WindowEvent::CloseRequested { .. } = e {
                let _ = w.app_handle().save_window_state(StateFlags::POSITION);
            }
        })
        .setup(|app| {
            // the avatar folder watcher lives as long as the app
            app.manage(Mutex::new(avatar::watch(app.handle().clone())));
            hotkey::start(app.handle());
            // p8 fix 5: the page shows images by file link; the link reaches the avatar folder only (not its sub-folders)
            let scope = app.asset_protocol_scope();
            let d = avatar::dir();
            scope.allow_directory(&d, false)?;
            if let Ok(c) = d.canonicalize() {
                let s = c.display().to_string();
                scope.allow_directory(s.strip_prefix(r"\\?\").unwrap_or(&s), false)?;
            }
            let show = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
            let hide = MenuItem::with_id(app, "hide", "Hide", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let m = Menu::with_items(app, &[&show, &hide, &quit])?;
            TrayIconBuilder::with_id("avatar")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("hayaku")
                .menu(&m)
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|tray, e| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                        toggle(tray.app_handle(), None);
                    }
                })
                .build(app)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("the avatar could not start");
}

#[cfg(test)]
mod tests {
    use super::{b64, is_answer, is_env_set, is_run_text, is_send};
    use serde_json::json;
    #[test]
    fn only_a_new_start_or_message_command_is_a_write() {
        let ok = json!({"op": "set", "path": "commands/abc123", "data": {"id": "abc123", "action": "start", "status": "new"}});
        assert!(is_send(&ok));
        assert!(is_send(&json!({"op": "set", "path": "commands/a1", "data": {"id": "a1", "action": "message", "status": "new"}})));
        assert!(is_send(&json!({"op": "set", "path": "commands/a1", "data": {"id": "a1", "action": "search", "status": "new"}})));
        for bad in [
            json!({"op": "set", "path": "commands/a1", "data": {"id": "a1", "action": "stop", "status": "new"}}),
            json!({"op": "set", "path": "commands/a1", "data": {"id": "a1", "action": "start", "status": "done"}}),
            json!({"op": "set", "path": "commands/a2", "data": {"id": "a1", "action": "start", "status": "new"}}),
            json!({"op": "set", "path": "meta/runs", "data": {"id": "runs", "action": "start", "status": "new"}}),
            json!({"op": "set", "path": "commands/a1", "merge": true, "data": {"id": "a1", "action": "start", "status": "new"}}),
            json!({"op": "delete", "path": "commands/a1"}),
            json!({"op": "batch", "writes": []}),
            json!({"op": "set", "path": "commands/../x", "data": {"id": "../x", "action": "start", "status": "new"}}),
        ] {
            assert!(!is_send(&bad), "{bad}");
        }
    }
    #[test]
    fn only_one_run_text_is_read() {
        assert!(is_run_text(&json!({"run": "abc123"})) && is_run_text(&json!({"live": "abc123"})));
        for bad in [json!({"session": "s1"}), json!({"run": "../x"}), json!({"run": ""}), json!({"run": "a", "live": "b"}),
                    json!({"reply": {"session": "s"}}), json!({"run": 5})] {
            assert!(!is_run_text(&bad), "{bad}");
        }
    }
    #[test]
    fn only_one_allowed_key_goes_to_the_env() {
        assert!(is_env_set(&json!({"op": "env_set", "name": "GEMINI_API_KEY", "value": "AIzaExample0123"})));
        for bad in [
            json!({"op": "env_set", "name": "WORK_ROOTS", "value": "C:/anything"}),
            json!({"op": "env_set", "name": "GEMINI_API_KEY", "value": "short"}),
            json!({"op": "env_set", "name": "GEMINI_API_KEY", "value": "AIzaExample0123", "path": "x/y"}),
            json!({"op": "env_set", "name": "GEMINI_API_KEY", "value": 12345678901u64}),
            json!({"op": "set", "name": "GEMINI_API_KEY", "value": "AIzaExample0123"}),
        ] {
            assert!(!is_env_set(&bad), "{bad}");
        }
    }
    #[test]
    fn only_an_answer_on_one_inbox_record_is_written() {
        let a = json!({"choice": "Allow", "text": "", "at": "2026-11-14T00:00:00Z"});
        for ok in [
            json!({"op": "update", "path": "inbox/abc123", "fields": {"status": "answered", "answer": a, "error": null}}),
            json!({"op": "update", "path": "inbox/abc123", "fields": {"draft": a, "thread": []}}),
        ] {
            assert!(is_answer(&ok), "{ok}");
        }
        for bad in [
            json!({"op": "update", "path": "inbox/abc123", "fields": {"status": "closed", "answer": a}}),
            json!({"op": "update", "path": "inbox/abc123", "fields": {"status": "answered"}}),
            json!({"op": "update", "path": "inbox/abc123", "fields": {"title": "x"}}),
            json!({"op": "update", "path": "inbox/abc123", "fields": {"error": "x"}}),
            json!({"op": "update", "path": "inbox/abc123", "fields": {}}),
            json!({"op": "update", "path": "commands/abc123", "fields": {"draft": a}}),
            json!({"op": "update", "path": "inbox/../x", "fields": {"draft": a}}),
            json!({"op": "set", "path": "inbox/abc123", "data": {"draft": a}}),
            json!({"op": "delete", "path": "inbox/abc123"}),
        ] {
            assert!(!is_answer(&bad), "{bad}");
        }
    }
    #[test]
    fn base64_matches_the_standard() {
        assert_eq!(b64(b""), "");
        assert_eq!(b64(b"f"), "Zg==");
        assert_eq!(b64(b"fo"), "Zm8=");
        assert_eq!(b64(b"foo"), "Zm9v");
        assert_eq!(b64(b"foobar"), "Zm9vYmFy");
        assert_eq!(b64(&[0xff, 0xfe, 0x00, 0x01]), "//4AAQ==");
    }
}
