// plan c5cb9485 s14: SET UP BRIDGE in CONFIG. The owner's words (2026-11-16): "I want to add the bridge install inside
// hayaku setting node, make it as I come to windows, linux, mac still can setup the bridge up, the other setting can
// show interactive panel to ask for the configuration or start login?"; preview "Approve" (2026-11-22); Linux "both
// ways" (this box, or a Linux box over ssh from here); repo missing "CLONE button".
// The only commands this file runs: git clone of the dashboard repo, the repo's own setup-box script for the target's
// OS (with checked values), and writing a new .env (only when none exists) from hayaku's own sign-in settings. Over ssh
// the same three run on the remote box. Nothing else.
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use tauri::{AppHandle, Emitter};

pub const REPO: &str = "https://github.com/hpdkhoa/awesome-agent-dashboard";
pub const SIGNIN_PORT: u16 = 8794; // the sign-in page's port on a box set up over ssh (setup-box.sh --signin-port)

pub fn ok_url(s: &str) -> bool {
    let rest = s.strip_prefix("https://").unwrap_or("");
    !rest.is_empty() && s.len() <= 200 && rest.chars().all(|c| c.is_ascii_alphanumeric() || "-._:/".contains(c))
}
pub fn ok_name(s: &str) -> bool {
    (1..=40).contains(&s.len()) && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}
pub fn ok_port(p: u32) -> bool { (1024..=65535).contains(&p) }
fn ok_path_chars(s: &str) -> bool {
    !s.is_empty() && s.len() <= 260 && !s.chars().any(|c| c.is_control() || "\"'`$;&|<>*?%!\n".contains(c))
}
/// an absolute folder path: C:\x or C:/x on Windows, /x on Linux and macOS
pub fn ok_dir(s: &str, posix: bool) -> bool {
    let abs = if posix { s.starts_with('/') } else {
        let b = s.as_bytes();
        b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/')
    };
    abs && ok_path_chars(s) && !s.contains("..")
}
/// WORK_ROOTS: "name=path;name=path", each path absolute
pub fn ok_roots(s: &str, posix: bool) -> bool {
    !s.is_empty() && s.len() <= 650 && s.split(';').all(|part| match part.split_once('=') {
        Some((n, p)) => ok_name(n) && ok_dir(p.trim(), posix),
        None => false,
    })
}
/// an ssh target: host, user@host or an ssh config alias
pub fn ok_host(s: &str) -> bool {
    (1..=80).contains(&s.len()) && !s.starts_with('-') && s.chars().all(|c| c.is_ascii_alphanumeric() || "._@-".contains(c))
}

fn hidden(cmd: &mut Command) -> &mut Command {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd
}
fn ssh(host: &str) -> Command {
    let mut c = Command::new("ssh");
    c.args(["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host]);
    c
}
fn this_os() -> &'static str {
    if cfg!(target_os = "windows") { "windows" } else if cfg!(target_os = "macos") { "macos" } else { "linux" }
}

/// what CONFIG needs to choose: this box's OS, whether its bridge answers, whether git and ssh are here
#[tauri::command]
pub async fn setup_probe() -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let has = |p: &str, a: &str| hidden(&mut Command::new(p)).arg(a).stdout(Stdio::null()).stderr(Stdio::null()).status().is_ok();
        let home = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).unwrap_or_default();
        serde_json::json!({"os": this_os(), "bridge": crate::bridge_up(), "git": has("git", "--version"),
            "ssh": has("ssh", "-V"), "home": home, "signedIn": crate::auth::config().is_some()})
    }).await.map_err(|e| e.to_string())
}

/// the folder's state: is the repo there (its setup script), is there a .env; host = over ssh
#[tauri::command]
pub async fn setup_repo(dir: String, host: Option<String>) -> Result<serde_json::Value, String> {
    let posix = host.is_some() || this_os() != "windows";
    if !ok_dir(&dir, posix) { return Err("not an absolute folder path".into()) }
    tauri::async_runtime::spawn_blocking(move || -> Result<serde_json::Value, String> {
        match host {
            Some(h) => {
                if !ok_host(&h) { return Err("not an ssh host".into()) }
                let out = hidden(&mut ssh(&h)).arg(format!(
                    "test -f '{dir}/bridge/setup-box.sh' && echo S; test -f '{dir}/.env' && echo E; test -e '{dir}' && echo X; uname -s"))
                    .output().map_err(|e| e.to_string())?;
                if !out.status.success() && out.stdout.is_empty() {
                    return Err(format!("ssh {h}: {}", String::from_utf8_lossy(&out.stderr).trim().chars().take(120).collect::<String>()));
                }
                let t = String::from_utf8_lossy(&out.stdout).to_string();
                let has = |k: &str| t.lines().any(|l| l.trim() == k);
                let os = if t.contains("Darwin") { "macos" } else { "linux" };
                Ok(serde_json::json!({"script": has("S"), "env": has("E"), "exists": has("X"), "os": os}))
            }
            None => {
                let p = std::path::Path::new(&dir);
                let script = p.join("bridge").join(if this_os() == "windows" { "setup-box.ps1" } else { "setup-box.sh" });
                Ok(serde_json::json!({"script": script.is_file(), "env": p.join(".env").is_file(), "exists": p.exists(), "os": this_os()}))
            }
        }
    }).await.map_err(|e| e.to_string())?
}

/// CLONE: git clone the dashboard repo into a folder that does not exist yet (or is empty)
#[tauri::command]
pub async fn setup_clone(app: AppHandle, dir: String, host: Option<String>) -> Result<i32, String> {
    let posix = host.is_some() || this_os() != "windows";
    if !ok_dir(&dir, posix) { return Err("not an absolute folder path".into()) }
    let mut cmd = match &host {
        Some(h) => {
            if !ok_host(h) { return Err("not an ssh host".into()) }
            let mut c = ssh(h);
            c.arg(format!("git clone {REPO} '{dir}' 2>&1"));
            c
        }
        None => {
            let p = std::path::Path::new(&dir);
            if p.exists() && p.read_dir().map(|mut d| d.next().is_some()).unwrap_or(true) {
                return Err("the folder exists and is not empty".into());
            }
            let mut c = Command::new("git");
            c.args(["clone", "--progress", REPO, &dir]);
            c
        }
    };
    stream(app, &mut cmd).await
}

/// a new .env for a box that has none: the shared lines from hayaku's own sign-in settings (no secret: the Firebase
/// web config is public by design, the owner's email, the page's origin). Refused when a .env is already there.
pub fn env_text() -> Result<String, String> {
    let c = crate::auth::config().ok_or("hayaku is not set up with Firebase here (no firebase.json)")?;
    let s = |k: &str| c.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
    let site = std::env::var("AGENT_SITE").unwrap_or_else(|_| crate::SITE.to_string());
    Ok(format!("# written by hayaku SET UP BRIDGE (s14) from its own sign-in settings\nFIREBASE_PROJECT_ID={p}\n\
        VITE_FIREBASE_PROJECT_ID={p}\nVITE_FIREBASE_API_KEY={k}\nVITE_FIREBASE_AUTH_DOMAIN={d}\nOWNER_EMAIL={e}\nSITE_ORIGINS={site}\n",
        p = s("projectId"), k = s("apiKey"), d = s("authDomain"), e = s("ownerEmail")))
}
#[tauri::command]
pub async fn setup_env(dir: String, host: Option<String>) -> Result<String, String> {
    let posix = host.is_some() || this_os() != "windows";
    if !ok_dir(&dir, posix) { return Err("not an absolute folder path".into()) }
    let text = env_text()?;
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        match host {
            Some(h) => {
                if !ok_host(&h) { return Err("not an ssh host".into()) }
                let mut ch = hidden(&mut ssh(&h)).arg(format!("test -e '{dir}/.env' && echo EXISTS || cat > '{dir}/.env'"))
                    .stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().map_err(|e| e.to_string())?;
                ch.stdin.take().ok_or("no stdin")?.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
                let out = ch.wait_with_output().map_err(|e| e.to_string())?;
                if String::from_utf8_lossy(&out.stdout).contains("EXISTS") { return Err(".env is already there: kept".into()) }
                if !out.status.success() { return Err("ssh could not write .env".into()) }
            }
            None => {
                let f = std::path::Path::new(&dir).join(".env");
                if f.exists() { return Err(".env is already there: kept".into()) }
                std::fs::write(&f, text).map_err(|e| e.to_string())?;
            }
        }
        Ok("written: FIREBASE_PROJECT_ID, VITE_FIREBASE_*, OWNER_EMAIL, SITE_ORIGINS".into())
    }).await.map_err(|e| e.to_string())?
}

/// the exact setup-box command for the target, shown in REVIEW and run by RUN / DRY RUN
pub fn setup_args(dir: &str, url: &str, roots: &str, name: &str, port: u32, dry: bool, host: Option<&str>)
    -> Result<(String, Vec<String>), String> {
    let posix = host.is_some() || this_os() != "windows";
    if !ok_dir(dir, posix) { return Err("BRIDGE FOLDER: not an absolute folder path".into()) }
    if !ok_url(url) { return Err("ADDRESS URL: must start with https:// (letters, digits, - . : / only)".into()) }
    if !ok_roots(roots, posix) { return Err("WORK FOLDERS: name=absolute path, ; between them".into()) }
    if !ok_name(name) { return Err("BOX NAME: 1 to 40 letters, digits, - or _".into()) }
    if !ok_port(port) { return Err("PORT: 1024 to 65535".into()) }
    if let Some(h) = host {
        if !ok_host(h) { return Err("SSH HOST: host or user@host".into()) }
        let mut line = format!("sh '{dir}/bridge/setup-box.sh' --url '{url}' --roots '{roots}' --name '{name}' --port {port} --signin-port {SIGNIN_PORT}");
        if dry { line.push_str(" --dry-run"); }
        return Ok(("ssh".into(), vec!["-o".into(), "BatchMode=yes".into(), "-o".into(), "ConnectTimeout=10".into(),
            "-L".into(), format!("{SIGNIN_PORT}:localhost:{SIGNIN_PORT}"), h.to_string(), format!("{line} 2>&1")]));
    }
    if this_os() == "windows" {
        let script = format!("{}\\bridge\\setup-box.ps1", dir.trim_end_matches(['\\', '/']));
        let mut a: Vec<String> = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", &script, "-Url", url, "-Roots", roots, "-Name", name, "-Port"]
            .iter().map(|s| s.to_string()).collect();
        a.push(port.to_string());
        if dry { a.push("-DryRun".into()); }
        Ok(("powershell".into(), a))
    } else {
        let script = format!("{}/bridge/setup-box.sh", dir.trim_end_matches('/'));
        let mut a: Vec<String> = vec![script, "--url".into(), url.into(), "--roots".into(), roots.into(), "--name".into(), name.into(),
            "--port".into(), port.to_string()];
        if dry { a.push("--dry-run".into()); }
        Ok(("sh".into(), a))
    }
}
#[tauri::command]
pub fn setup_command(dir: String, url: String, roots: String, name: String, port: u32, dry: bool, host: Option<String>) -> Result<String, String> {
    let (p, a) = setup_args(&dir, &url, &roots, &name, port, dry, host.as_deref())?;
    Ok(std::iter::once(p).chain(a.into_iter().map(|x| if x.contains(' ') { format!("\"{x}\"") } else { x })).collect::<Vec<_>>().join(" "))
}
#[tauri::command]
pub async fn setup_run(app: AppHandle, dir: String, url: String, roots: String, name: String, port: u32, dry: bool,
    host: Option<String>) -> Result<i32, String> {
    let (p, a) = setup_args(&dir, &url, &roots, &name, port, dry, host.as_deref())?;
    let mut cmd = Command::new(p);
    cmd.args(a);
    if host.is_none() { cmd.current_dir(&dir); }
    stream(app, &mut cmd).await
}

/// START LOGIN: the bridge's sign-in page on this box (localhost only; over ssh the tunnel brings it here)
#[tauri::command]
pub fn setup_login(port: u32) -> Result<(), String> {
    if !ok_port(port) { return Err("not a port".into()) }
    crate::open_url(&format!("http://localhost:{port}/"))
}

/// runs the command, sends each output line to the page as a "setup-line" event, returns the exit code
async fn stream(app: AppHandle, cmd: &mut Command) -> Result<i32, String> {
    hidden(cmd).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).env("PYTHONUNBUFFERED", "1");
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let out = child.stdout.take().ok_or("no output")?;
    let err = child.stderr.take().ok_or("no output")?;
    let a2 = app.clone();
    let t = std::thread::spawn(move || for l in BufReader::new(err).lines().map_while(Result::ok) { let _ = a2.emit("setup-line", l); });
    tauri::async_runtime::spawn_blocking(move || -> Result<i32, String> {
        for l in BufReader::new(out).lines().map_while(Result::ok) { let _ = app.emit("setup-line", l); }
        let _ = t.join();
        Ok(child.wait().map_err(|e| e.to_string())?.code().unwrap_or(-1))
    }).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn values_are_checked() {
        assert!(ok_url("https://box2-files.example.com") && !ok_url("http://x.example") && !ok_url("https://x\"; rm -rf /")
            && !ok_url("https://a b"));
        assert!(ok_name("Mac-Studio") && !ok_name("a b") && !ok_name("") && !ok_name("x;y"));
        assert!(ok_port(8793) && !ok_port(80) && !ok_port(70000));
        assert!(ok_dir("C:\\Users\\me\\repo", false) && ok_dir("D:/a", false) && !ok_dir("repo", false) && !ok_dir("C:\\a\\..\\b", false)
            && ok_dir("/home/me/repo", true) && !ok_dir("/home/$(x)", true) && !ok_dir("/a'b", true));
        assert!(ok_roots("projects=K:\\Projects;work=D:\\Work", false) && ok_roots("labs=/home/me/labs", true)
            && !ok_roots("projects", false) && !ok_roots("p=relative", false) && !ok_roots("a b=C:\\x", false));
        assert!(ok_host("linux") && ok_host("me@192.168.1.222") && !ok_host("-oProxyCommand=x") && !ok_host("a b"));
    }
    #[test]
    fn only_the_setup_script_runs() {
        let (p, a) = setup_args("/home/me/aad", "https://b.example", "labs=/home/me/labs", "linux", 8793, true, Some("linux")).unwrap();
        assert_eq!(p, "ssh");
        assert!(a.last().unwrap().starts_with("sh '/home/me/aad/bridge/setup-box.sh'") && a.last().unwrap().contains("--dry-run"));
        assert!(setup_args("/home/me/aad", "http://b.example", "labs=/x", "n", 8793, true, Some("linux")).is_err());
        assert!(setup_args("/home/me/aad", "https://b.example", "labs=/x", "n", 8793, true, Some("-oProxyCommand=calc")).is_err());
        assert!(setup_args("/home/me/aad", "https://b.example", "labs=/x;$(reboot)", "n", 8793, true, Some("linux")).is_err());
    }
}
