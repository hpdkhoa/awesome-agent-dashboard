//! Sign-in for an avatar with no bridge of its own (plan b73e97ad p11; the owner's picks, 2026-11-11: "C: bridges
//! publish, avatar listens", "All, merged + picker"; the first such machine is the owner's Mac).
//!
//! The same way the bridge signs in (bridge/agent_bridge/auth.py): a small page on http://localhost:<port> (localhost
//! is a Firebase authorized domain by default) signs in with Google through the Firebase web SDK and posts the
//! Firebase user back with a one-time code. Only the owner's email (firebase.json "ownerEmail") is kept; any other is
//! refused here, and the Firestore rules refuse it too. The user (it holds the Firebase refresh token) goes to the OS
//! key store (Windows Credential Manager, macOS Keychain), never to a file, the repo or Firestore. No Claude
//! credential is involved.
//!
//! firebase.json (next to the avatars folder; public project settings, kept out of the repo like the bridge's .env):
//! {"apiKey": "...", "authDomain": "...", "projectId": "...", "ownerEmail": "..."}

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use serde_json::Value;
use tauri::{AppHandle, Emitter};

const SERVICE: &str = "agent-avatar";
const USER: &str = "firebase-user";
const FIREBASE_JS: &str = "https://www.gstatic.com/firebasejs/11.10.0";

pub fn config_path() -> PathBuf {
    crate::avatar::dir().parent().map(|p| p.join("firebase.json")).unwrap_or_else(|| PathBuf::from("firebase.json"))
}

/// The Firebase settings, or None when this machine has none (then the avatar uses its local bridge only).
pub fn config() -> Option<Value> {
    let text = std::fs::read_to_string(config_path()).ok()?;
    let v: Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()?;
    for k in ["apiKey", "authDomain", "projectId", "ownerEmail"] {
        if v.get(k).and_then(|x| x.as_str()).map_or(true, |s| s.is_empty()) {
            return None;
        }
    }
    Some(v)
}

fn owner() -> Option<String> {
    config().and_then(|c| c["ownerEmail"].as_str().map(|s| s.to_ascii_lowercase()))
}

/// Keeps a user only when it is the owner's verified email.
fn check(user_json: &str) -> Result<(), String> {
    let u: Value = serde_json::from_str(user_json).map_err(|_| "not a Firebase user".to_string())?;
    let email = u["email"].as_str().unwrap_or("").to_ascii_lowercase();
    let verified = u["emailVerified"].as_bool().unwrap_or(false);
    match owner() {
        Some(o) if o == email && verified => Ok(()),
        Some(_) => Err(format!("refused: {email} is not the owner")),
        None => Err("no firebase.json on this machine".into()),
    }
}

fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, USER).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn fb_config() -> Option<Value> {
    config()
}

#[tauri::command]
pub fn auth_get() -> Option<String> {
    let u = entry().ok()?.get_password().ok()?;
    check(&u).ok().map(|_| u)
}

/// The page hands back the user after the Firebase SDK refreshed it (a new refresh token is kept too).
#[tauri::command]
pub fn auth_set(json: String) -> Result<(), String> {
    check(&json)?;
    entry()?.set_password(&slim(&json)?).map_err(|e| e.to_string())
}

/// Only what brings the sign-in back: the user's ids and the refresh token. The hour-long access token is dropped
/// (the Firebase SDK gets a fresh one from the refresh token on start), and so are the photo and display fields:
/// Windows Credential Manager holds at most 2,560 characters (measured: the whole user is longer).
fn slim(json: &str) -> Result<String, String> {
    let u: Value = serde_json::from_str(json).map_err(|e| e.to_string())?;
    let mut o = serde_json::Map::new();
    for k in ["uid", "email", "emailVerified", "isAnonymous", "createdAt", "lastLoginAt", "apiKey", "appName"] {
        if let Some(v) = u.get(k) {
            o.insert(k.into(), v.clone());
        }
    }
    let providers: Vec<Value> = u["providerData"].as_array().map(|a| a.iter().map(|p| serde_json::json!({
        "providerId": p["providerId"], "uid": p["uid"], "email": p["email"] })).collect()).unwrap_or_default();
    o.insert("providerData".into(), Value::Array(providers));
    let rt = u["stsTokenManager"]["refreshToken"].as_str().ok_or("no refresh token")?;
    o.insert("stsTokenManager".into(), serde_json::json!({ "refreshToken": rt }));
    Ok(Value::Object(o).to_string())
}

pub fn clear() {
    if let Ok(e) = entry() {
        let _ = e.delete_credential();
    }
}

fn page(cfg: &Value, code: &str) -> String {
    format!(
        r#"<!doctype html><meta charset="utf-8"><title>hayaku sign-in</title>
<body style="font:16px system-ui;max-width:420px;margin:15vh auto">
<h1 style="font-size:20px;font-weight:500">hayaku sign-in</h1><p id="s">Click to sign in with your Google account.</p>
<button id="b">Sign in with Google</button>
<script type="module">
import {{ initializeApp }} from "{js}/firebase-app.js";
import {{ getAuth, GoogleAuthProvider, signInWithPopup }} from "{js}/firebase-auth.js";
const auth = getAuth(initializeApp({{ apiKey: "{key}", authDomain: "{dom}", projectId: "{proj}" }}));
const s = document.getElementById("s");
document.getElementById("b").onclick = async () => {{
  try {{
    const r = await signInWithPopup(auth, new GoogleAuthProvider());
    const ok = await fetch("/done?code={code}", {{ method: "POST", body: JSON.stringify(r.user.toJSON()) }});
    s.textContent = ok.status === 204 ? "Signed in. You can close this tab." : "Refused: " + await ok.text();
  }} catch (e) {{ s.textContent = "Sign-in failed: " + (e.code || e.message); }}
}};
</script>"#,
        js = FIREBASE_JS,
        key = cfg["apiKey"].as_str().unwrap_or(""),
        dom = cfg["authDomain"].as_str().unwrap_or(""),
        proj = cfg["projectId"].as_str().unwrap_or(""),
        code = code
    )
}

fn open_browser(url: &str) {
    #[cfg(target_os = "windows")]
    let _ = std::process::Command::new("explorer").arg(url).spawn();
    #[cfg(target_os = "macos")]
    let _ = std::process::Command::new("open").arg(url).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let _ = std::process::Command::new("xdg-open").arg(url).spawn();
}

/// Serves the sign-in page for up to 5 minutes; a posted owner user is stored and the page is told ("auth").
pub fn sign_in(app: AppHandle) {
    std::thread::spawn(move || {
        let Some(cfg) = config() else {
            let _ = app.emit("auth-error", "no firebase.json on this machine");
            return;
        };
        let Ok(srv) = TcpListener::bind("127.0.0.1:0") else { return };
        let port = srv.local_addr().map(|a| a.port()).unwrap_or(0);
        let code: String = {
            use std::hash::{BuildHasher, Hasher};
            let mut h = std::collections::hash_map::RandomState::new().build_hasher();
            h.write_u128(Instant::now().elapsed().as_nanos() ^ (std::process::id() as u128));
            format!("{:016x}{:016x}", h.finish(), std::collections::hash_map::RandomState::new().build_hasher().finish())
        };
        let html = page(&cfg, &code);
        let _ = srv.set_nonblocking(true);
        open_browser(&format!("http://localhost:{port}/"));
        let end = Instant::now() + Duration::from_secs(300);
        while Instant::now() < end {
            let Ok((mut s, _)) = srv.accept() else {
                std::thread::sleep(Duration::from_millis(100));
                continue;
            };
            let _ = s.set_nonblocking(false);
            let _ = s.set_read_timeout(Some(Duration::from_secs(10)));
            let mut r = BufReader::new(match s.try_clone() { Ok(c) => c, Err(_) => continue });
            let mut first = String::new();
            if r.read_line(&mut first).is_err() {
                continue;
            }
            let mut len = 0usize;
            loop {
                let mut l = String::new();
                if r.read_line(&mut l).is_err() || l == "\r\n" || l.is_empty() {
                    break;
                }
                if let Some(v) = l.to_ascii_lowercase().strip_prefix("content-length:") {
                    len = v.trim().parse().unwrap_or(0);
                }
            }
            let reply = |s: &mut std::net::TcpStream, code: &str, ctype: &str, body: &str| {
                let _ = write!(s, "HTTP/1.1 {code}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            };
            if first.starts_with("GET / ") {
                reply(&mut s, "200 OK", "text/html; charset=utf-8", &html);
            } else if first.starts_with(&format!("POST /done?code={code} ")) && len > 0 && len < 64 * 1024 {
                let mut body = vec![0u8; len];
                if r.read_exact(&mut body).is_err() {
                    continue;
                }
                let json = String::from_utf8_lossy(&body).to_string();
                match check(&json).and_then(|_| auth_set(json)) {
                    Ok(()) => {
                        reply(&mut s, "204 No Content", "text/plain", "");
                        let _ = app.emit("auth", ());
                        return;
                    }
                    Err(e) => {
                        reply(&mut s, "403 Forbidden", "text/plain", &e);
                        let _ = app.emit("auth-error", e);
                    }
                }
            } else {
                reply(&mut s, "404 Not Found", "text/plain", "");
            }
        }
    });
}
