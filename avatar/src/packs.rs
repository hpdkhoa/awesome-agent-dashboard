//! hayaku avatar packs (the owner's picks 2026-11-17: "B+file", "only pictures", "Local only"). A .hayaku file is a
//! zip: pack.json {"format": 1, "name", "statuses": {status: file name}} and the pictures, the same format as the
//! bridge's (bridge/agent_bridge/avatarpacks.py). Applying a pack copies its pictures into the avatar folder as
//! <status>.<ext> and names them in avatar.json; a status the pack has no picture for shows the robot. Only pictures
//! change: the fit and every other avatar.json key stay. The bridge keeps the packs; the page (app.js) lists them,
//! asks the bridge for one through box_packs, and hands it here.

use std::fs;
use std::io::{Read, Write};
use std::path::Path;

use serde_json::{Map, Value};
use tauri::{AppHandle, Emitter};

use crate::avatar::{cfg, dir, save, EXTS, MAX_BYTES, STATUSES};

pub type Pic = (String, String, Vec<u8>); // status, ext, bytes

/// The bytes look like the type the name says (the bridge's picture_ok).
fn picture_ok(data: &[u8], ext: &str) -> bool {
    match ext {
        "gif" => data.starts_with(b"GIF87a") || data.starts_with(b"GIF89a"),
        "png" | "apng" => data.starts_with(b"\x89PNG"),
        "jpg" | "jpeg" => data.starts_with(b"\xff\xd8"),
        "bmp" => data.starts_with(b"BM"),
        "webp" => data.len() >= 12 && &data[..4] == b"RIFF" && &data[8..12] == b"WEBP",
        "svg" => String::from_utf8_lossy(&data[..data.len().min(4096)]).to_ascii_lowercase().contains("<svg"),
        _ => false,
    }
}

/// A .hayaku file -> (name, pictures). Refuses what the bridge refuses.
pub fn read_pack(raw: &[u8]) -> Result<(String, Vec<Pic>), String> {
    if raw.len() as u64 > 4 * MAX_BYTES + 64 * 1024 {
        return Err("the .hayaku file is over 80 MB".into());
    }
    let mut z = zip::ZipArchive::new(std::io::Cursor::new(raw)).map_err(|_| "not a .hayaku file (a zip with pack.json)")?;
    let meta: Value = {
        let mut f = z.by_name("pack.json").map_err(|_| "no pack.json in the .hayaku file")?;
        let mut t = String::new();
        f.read_to_string(&mut t).map_err(|_| "pack.json is not text")?;
        serde_json::from_str(t.trim_start_matches('\u{feff}')).map_err(|_| "pack.json is not JSON")?
    };
    let sts = meta.get("statuses").and_then(|v| v.as_object()).ok_or("pack.json needs statuses")?;
    let mut out = Vec::new();
    for (st, fname) in sts {
        if !STATUSES.iter().any(|(k, _)| k == st) {
            return Err(format!("unknown status {st}"));
        }
        let fname = fname.as_str().ok_or(format!("{st}: no picture name"))?;
        if fname.contains('/') || fname.contains('\\') || fname.starts_with('.') {
            return Err(format!("{st}: a picture name with no folder"));
        }
        let ext = fname.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default();
        if !EXTS.contains(&ext.as_str()) {
            return Err(format!("{fname}: not a picture type"));
        }
        let f = z.by_name(fname).map_err(|_| format!("{st}: {fname} is not in the .hayaku file"))?;
        if f.size() > MAX_BYTES {
            return Err(format!("{st}: {fname} is over 20 MB"));
        }
        let mut data = Vec::new();
        f.take(MAX_BYTES + 1).read_to_end(&mut data).map_err(|e| e.to_string())?;
        if !picture_ok(&data, &ext) {
            return Err(format!("the {ext} picture is not a {ext} file"));
        }
        out.push((st.clone(), ext, data));
    }
    if out.is_empty() {
        return Err("the pack has no picture".into());
    }
    let name: String = meta.get("name").and_then(|v| v.as_str()).unwrap_or("").chars().filter(|c| !c.is_control()).take(60).collect();
    let name = name.trim();
    Ok((if name.is_empty() { "Pack".into() } else { name.to_string() }, out))
}

pub fn write_pack(name: &str, pics: &[Pic]) -> Result<Vec<u8>, String> {
    let mut buf = std::io::Cursor::new(Vec::new());
    {
        let mut z = zip::ZipWriter::new(&mut buf);
        let opt = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        let sts: Map<String, Value> = pics.iter().map(|(st, ext, _)| (st.clone(), Value::String(format!("{st}.{ext}")))).collect();
        let meta = serde_json::json!({"format": 1, "name": name, "statuses": sts});
        z.start_file("pack.json", opt).map_err(|e| e.to_string())?;
        z.write_all(serde_json::to_string_pretty(&meta).map_err(|e| e.to_string())?.as_bytes()).map_err(|e| e.to_string())?;
        for (st, ext, data) in pics {
            z.start_file(format!("{st}.{ext}"), opt).map_err(|e| e.to_string())?;
            z.write_all(data).map_err(|e| e.to_string())?;
        }
        z.finish().map_err(|e| e.to_string())?;
    }
    Ok(buf.into_inner())
}

/// The pictures hayaku shows now, as a .hayaku file. None set: refused (the robot is built in, not a picture).
pub fn current_zip(name: &str) -> Result<Vec<u8>, String> {
    let c = cfg();
    let folder = dir();
    let mut pics = Vec::new();
    for (k, _) in STATUSES {
        if let Some(f) = c.get(k).and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
            let p = folder.join(f);
            if !p.starts_with(&folder) || f.contains("..") {
                return Err(format!("{f} is outside the avatar folder"));
            }
            let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
            let data = fs::read(&p).map_err(|_| format!("{f} is missing"))?;
            if data.len() as u64 > MAX_BYTES {
                return Err(format!("{f} is over 20 MB"));
            }
            pics.push((k.to_string(), ext, data));
        }
    }
    if pics.is_empty() {
        return Err("no picture set: hayaku shows the robot".into());
    }
    write_pack(name, &pics)
}

/// Shows a pack: its pictures go into the folder as <status>.<ext>, avatar.json names them; others go back to the robot.
pub fn apply_pack(app: &AppHandle, raw: &[u8]) -> Result<String, String> {
    let (name, pics) = read_pack(raw)?;
    let folder = dir();
    let mut c = cfg();
    for (k, _) in STATUSES {
        c.remove(k);
    }
    for (st, ext, data) in &pics {
        let fname = format!("{st}.{ext}");
        let tmp = folder.join(format!("{st}.part"));
        fs::write(&tmp, data).map_err(|e| e.to_string())?;
        fs::rename(&tmp, folder.join(&fname)).map_err(|e| e.to_string())?;
        c.insert(st.clone(), Value::String(fname));
    }
    save(&c)?;
    let _ = app.emit("avatars", ());
    Ok(name)
}

/// A .hayaku file from the menu or dropped on the badge: shown at once, then handed to the page, which adds it to the
/// bridge's packs and makes it the one hayaku follows.
pub fn import_file(app: &AppHandle, p: &Path) {
    let r = fs::read(p).map_err(|e| e.to_string()).and_then(|raw| apply_pack(app, &raw).map(|n| (n, raw)));
    let _ = match r {
        Ok((name, raw)) => app.emit_to("main", "pack-upload", serde_json::json!({"name": name, "zip": crate::b64(&raw)})),
        Err(e) => app.emit_to("main", "pack-msg", format!("✕ import: {e}")),
    };
}

/// Export the current pictures to a .hayaku file the owner names.
pub fn export(app: &AppHandle) {
    use tauri_plugin_dialog::DialogExt;
    let app = app.clone();
    std::thread::spawn(move || {
        let picked = app.dialog().file().set_title("Export the current pictures as a .hayaku file")
            .add_filter("hayaku pack", &["hayaku"]).set_file_name("hayaku.hayaku").blocking_save_file();
        if let Some(p) = picked.and_then(|f| f.into_path().ok()) {
            let r = current_zip("hayaku").and_then(|z| fs::write(&p, z).map_err(|e| e.to_string()));
            let _ = app.emit_to("main", "pack-msg", match r {
                Ok(()) => format!("exported {}", p.file_name().and_then(|n| n.to_str()).unwrap_or("")),
                Err(e) => format!("✕ export: {e}"),
            });
        }
    });
}

/// Import a .hayaku file the owner picks.
pub fn import(app: &AppHandle) {
    use tauri_plugin_dialog::DialogExt;
    let app = app.clone();
    std::thread::spawn(move || {
        let picked = app.dialog().file().set_title("Import a .hayaku file").add_filter("hayaku pack", &["hayaku"]).blocking_pick_file();
        if let Some(p) = picked.and_then(|f| f.into_path().ok()) {
            import_file(&app, &p);
        }
    });
}

/// The page's two pack calls: the current pictures as a .hayaku file (base64, for "Save current as pack"), and a pack
/// from the bridge shown (base64 in).
#[tauri::command]
pub fn pack_current() -> Result<String, String> {
    current_zip("hayaku").map(|z| crate::b64(&z))
}

#[tauri::command]
pub fn pack_apply(app: AppHandle, zip: String) -> Result<String, String> {
    apply_pack(&app, &unb64(&zip).ok_or("the pack did not arrive whole")?)
}

pub fn unb64(s: &str) -> Option<Vec<u8>> {
    let val = |c: u8| -> Option<u32> {
        Some(match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        } as u32)
    };
    let s: Vec<u8> = s.bytes().filter(|c| !c.is_ascii_whitespace()).collect();
    if s.len() % 4 != 0 {
        return None;
    }
    let mut out = Vec::with_capacity(s.len() / 4 * 3);
    for ch in s.chunks(4) {
        let pad = ch.iter().rev().take_while(|&&c| c == b'=').count();
        if pad > 2 || ch[..4 - pad].contains(&b'=') {
            return None;
        }
        let mut n = 0u32;
        for &c in &ch[..4 - pad] {
            n = n << 6 | val(c)?;
        }
        n <<= 6 * pad as u32;
        let b = [(n >> 16) as u8, (n >> 8) as u8, n as u8];
        out.extend_from_slice(&b[..3 - pad]);
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    const GIF: &[u8] = b"GIF89a0000000000";
    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n00000000";

    fn one(st: &str, ext: &str, data: &[u8]) -> Vec<u8> {
        write_pack("x", &[(st.into(), ext.into(), data.to_vec())]).unwrap()
    }

    #[test]
    fn a_pack_goes_out_and_back_the_same() {
        let pics = vec![("done".to_string(), "gif".to_string(), GIF.to_vec()), ("needs_you".to_string(), "png".to_string(), PNG.to_vec())];
        let (name, back) = read_pack(&write_pack("Cats", &pics).unwrap()).unwrap();
        assert_eq!(name, "Cats");
        assert_eq!(back.len(), 2);
        assert!(back.contains(&pics[0]) && back.contains(&pics[1]));
    }

    #[test]
    fn a_pack_the_bridge_wrote_reads_here() {
        // testdata/bridge-made.hayaku: written by bridge avatarpacks.write_zip (the same format both ways)
        let (name, pics) = read_pack(include_bytes!("../testdata/bridge-made.hayaku")).unwrap();
        assert_eq!(name, "From bridge");
        let mut sts: Vec<_> = pics.iter().map(|(s, e, _)| format!("{s}.{e}")).collect();
        sts.sort();
        assert_eq!(sts, ["done.gif", "offline.png"]);
    }

    #[test]
    fn a_bad_pack_is_refused() {
        assert!(read_pack(b"not a zip").is_err());
        assert!(read_pack(&one("sleeping", "gif", GIF)).unwrap_err().contains("unknown status"));
        assert!(read_pack(&one("done", "exe", GIF)).unwrap_err().contains("not a picture type"));
        assert!(read_pack(&one("done", "gif", b"hello")).unwrap_err().contains("not a gif"));
        assert!(read_pack(&write_pack("x", &[]).unwrap()).unwrap_err().contains("no picture"));
    }

    #[test]
    fn base64_back_matches() {
        for d in [&b""[..], b"f", b"fo", b"foo", b"foobar", &[0xff, 0xfe, 0x00, 0x01]] {
            assert_eq!(unb64(&crate::b64(d)).unwrap(), d);
        }
        assert!(unb64("Zg=").is_none() && unb64("Z=g=").is_none() && unb64("Zm9v!A==").is_none());
    }
}
