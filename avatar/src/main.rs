//! The desktop avatar (plan b73e97ad, step p3): a frameless, always-on-top box that shows the bridge's /status
//! (127.0.0.1:8794, bridge/agent_bridge/status.py) and this PC's CPU, RAM and GPU. Drag anywhere to move; the
//! position is kept. Right click or the tray icon: hide, show, quit. OFFLINE when /status does not answer.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, WebviewWindow, WindowEvent};
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

/// The right-click menu on the box.
#[tauri::command]
fn menu(window: WebviewWindow) -> Result<(), String> {
    let app = window.app_handle();
    let hide = MenuItem::with_id(app, "hide", "Hide", true, None::<&str>).map_err(|e| e.to_string())?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>).map_err(|e| e.to_string())?;
    let m = Menu::with_items(app, &[&hide, &quit]).map_err(|e| e.to_string())?;
    window.popup_menu(&m).map_err(|e| e.to_string())
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
        .manage(Load { sys: Mutex::new(sys), nvml: nvml_wrapper::Nvml::init().ok() })
        .invoke_handler(tauri::generate_handler![status, load, menu])
        .on_menu_event(|app, e| match e.id().as_ref() {
            "hide" => toggle(app, Some(false)),
            "show" => toggle(app, Some(true)),
            "quit" => quit(app),
            _ => {}
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
