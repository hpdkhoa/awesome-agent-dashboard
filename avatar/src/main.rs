//! The desktop avatar (plan b73e97ad, step p3): a frameless, always-on-top box that shows the bridge's /status
//! (127.0.0.1:8794, bridge/agent_bridge/status.py) and this PC's CPU, RAM and GPU. Drag anywhere to move; the
//! position is kept. Right click or the tray icon: hide, show, quit. OFFLINE when /status does not answer.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod auth;
mod avatar;

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
    let m = Menu::with_items(app, &[&size, &av, &fol, &sep2, &sign, &sep, &hide, &quit]).map_err(e)?;
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
        .manage(Load { sys: Mutex::new(sys), nvml: nvml_wrapper::Nvml::init().ok() })
        .manage(avatar::Pending(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![status, load, menu, avatar::avatars, avatar::drop_ask, auth::fb_config,
            auth::auth_get, auth::auth_set])
        .on_menu_event(|app, e| match e.id().as_ref() {
            "hide" => toggle(app, Some(false)),
            "show" => toggle(app, Some(true)),
            "quit" => quit(app),
            "signin" => auth::sign_in(app.clone()),
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
                .tooltip("Agent Avatar")
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
