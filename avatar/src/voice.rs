//! plan c5cb9485 s6, (b) the voice toggle, English. The owner's words (2026-11-14): "no need to hold, use toggle just
//! click and mic on to use speech to text until I click send"; pick "Hotkey = SEND + mic on". Round 1: "b use A: local
//! whisper.cpp inside the avatar ... and B: the OS speech engine"; round 2: "A main, B fallback", "English only".
//!
//! The s5 key (or the MIC button) turns the mic on; Send, Esc or closing the SEND box turns it off. While it is on, the
//! sound is cut at each pause (about 0.7 s of quiet) and each piece goes to whisper.cpp (ggml-base.en, loaded at mic on,
//! dropped at mic off); the text goes into node 3's message. No model, or whisper fails: the Windows speech engine
//! (System.Speech, en-US) reads the piece instead. Audio never leaves this machine: it lives in memory, and only the
//! Windows fallback writes one piece to a temp WAV, deleted as soon as it is read.
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, State};

pub const RATE: usize = 16_000;
const FRAME: usize = 480;              // 30 ms at 16 kHz
const PAUSE_MS: usize = 700;           // quiet that ends a piece
const PRE_MS: usize = 240;             // sound kept before the first loud frame
const MIN_SPEECH_MS: usize = 300;      // shorter pieces are noise
const MAX_PIECE_S: usize = 25;         // a piece is cut here even without a pause (whisper reads 30 s at most)

pub fn model_path() -> PathBuf {
    let d = crate::avatar::dir();
    d.parent().map(|p| p.to_path_buf()).unwrap_or(d).join("models").join("ggml-base.en.bin")
}

#[derive(Default)]
pub struct Voice(Mutex<Option<Talk>>);
struct Talk {
    stop: Arc<AtomicBool>,
    flush: Arc<AtomicBool>,
    done: Receiver<()>,
}

// --- sound in: the mic (or, for the tests only, a WAV file played at real time) -> 16 kHz mono pieces -----------------

/// A streaming windowed-sinc resampler (any rate -> 16 kHz), low-pass at 0.9 of the lower Nyquist.
pub struct Resampler { step: f64, pos: f64, hist: Vec<f32>, cut: f64 }
const HALF: usize = 16;
impl Resampler {
    pub fn new(from: u32) -> Self {
        let step = from as f64 / RATE as f64;
        Resampler { step, pos: HALF as f64, hist: vec![0.0; HALF], cut: 0.9 / step.max(1.0) }
    }
    pub fn push(&mut self, input: &[f32], out: &mut Vec<f32>) {
        self.hist.extend_from_slice(input);
        while self.pos + (HALF as f64) < self.hist.len() as f64 {
            let c = self.pos.floor() as isize;
            let mut acc = 0.0f64;
            let mut wsum = 0.0f64;
            for k in (c - HALF as isize + 1)..=(c + HALF as isize) {
                if k < 0 || k as usize >= self.hist.len() { continue; }
                let x = (k as f64 - self.pos) * self.cut;
                let sinc = if x.abs() < 1e-9 { 1.0 } else { (std::f64::consts::PI * x).sin() / (std::f64::consts::PI * x) };
                let t = (k as f64 - self.pos) / HALF as f64;
                let win = if t.abs() >= 1.0 { 0.0 } else { 0.5 * (1.0 + (std::f64::consts::PI * t).cos()) };
                let w = sinc * win;
                acc += self.hist[k as usize] as f64 * w;
                wsum += w;
            }
            out.push(if wsum.abs() > 1e-9 { (acc / wsum) as f32 } else { 0.0 });
            self.pos += self.step;
        }
        // keep only what the next outputs still need
        let keep_from = (self.pos.floor() as usize).saturating_sub(HALF);
        if keep_from > 0 {
            self.hist.drain(..keep_from);
            self.pos -= keep_from as f64;
        }
    }
}

fn mic(stop: Arc<AtomicBool>, tx: Sender<Vec<f32>>, ready: Sender<Result<String, String>>) {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    let host = cpal::default_host();
    let Some(dev) = host.default_input_device() else { let _ = ready.send(Err("no microphone found".into())); return };
    let cfg = match dev.default_input_config() { Ok(c) => c, Err(e) => { let _ = ready.send(Err(format!("microphone: {e}"))); return } };
    let ch = cfg.channels() as usize;
    let rs = Arc::new(Mutex::new(Resampler::new(cfg.sample_rate())));
    let name = dev.description().map(|d| d.to_string()).unwrap_or_else(|_| "microphone".into());
    macro_rules! build {
        ($t:ty, $f:expr) => {{
            let (rs, tx) = (rs.clone(), tx.clone());
            dev.build_input_stream::<$t, _, _>(cfg.config(), move |d: &[$t], _| {
                let mono: Vec<f32> = d.chunks(ch).map(|c| c.iter().map(|s| $f(*s)).sum::<f32>() / ch as f32).collect();
                let mut out = Vec::with_capacity(mono.len() / 2);
                rs.lock().unwrap().push(&mono, &mut out);
                let _ = tx.send(out);
            }, |_e| {}, None)
        }};
    }
    let stream = match cfg.sample_format() {
        cpal::SampleFormat::F32 => build!(f32, |s: f32| s),
        cpal::SampleFormat::I16 => build!(i16, |s: i16| s as f32 / 32768.0),
        cpal::SampleFormat::U16 => build!(u16, |s: u16| (s as f32 - 32768.0) / 32768.0),
        cpal::SampleFormat::I32 => build!(i32, |s: i32| s as f32 / 2147483648.0),
        f => { let _ = ready.send(Err(format!("microphone format {f:?} not handled"))); return }
    };
    let stream = match stream { Ok(s) => s, Err(e) => { let _ = ready.send(Err(format!("microphone: {e}"))); return } };
    if let Err(e) = stream.play() { let _ = ready.send(Err(format!("microphone: {e}"))); return; }
    let _ = ready.send(Ok(name));
    while !stop.load(Ordering::SeqCst) { std::thread::sleep(Duration::from_millis(20)); }
    drop(stream);   // the mic is off here
}

// tests only (AVATAR_VOICE_TEST=<wav>): the file stands in for the mic, played at real time, then silence
fn file_in(path: String, stop: Arc<AtomicBool>, tx: Sender<Vec<f32>>, ready: Sender<Result<String, String>>) {
    let s = match read_wav(&path) { Ok(s) => s, Err(e) => { let _ = ready.send(Err(e)); return } };
    let _ = ready.send(Ok(format!("test file {}", std::path::Path::new(&path).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default())));
    let chunk = RATE / 50;   // 20 ms
    let mut i = 0;
    while !stop.load(Ordering::SeqCst) {
        let piece = if i < s.len() { s[i..(i + chunk).min(s.len())].to_vec() } else { vec![0.0; chunk] };
        i += chunk;
        let _ = tx.send(piece);
        std::thread::sleep(Duration::from_millis(20));
    }
}

pub fn read_wav(path: &str) -> Result<Vec<f32>, String> {
    let mut r = hound::WavReader::open(path).map_err(|e| e.to_string())?;
    let sp = r.spec();
    let ch = sp.channels as usize;
    let raw: Vec<f32> = match sp.sample_format {
        hound::SampleFormat::Float => r.samples::<f32>().filter_map(Result::ok).collect(),
        hound::SampleFormat::Int => { let m = (1i64 << (sp.bits_per_sample - 1)) as f32; r.samples::<i32>().filter_map(Result::ok).map(|s| s as f32 / m).collect() }
    };
    let mono: Vec<f32> = raw.chunks(ch).map(|c| c.iter().sum::<f32>() / ch as f32).collect();
    if sp.sample_rate as usize == RATE { return Ok(mono); }
    let mut out = Vec::new();
    let mut rs = Resampler::new(sp.sample_rate);
    rs.push(&mono, &mut out);
    rs.push(&vec![0.0; HALF * 4], &mut out);
    Ok(out)
}

// --- cutting at pauses -------------------------------------------------------------------------------------------------

/// Frames of 30 ms; loud = RMS over max(0.01, 3 x the quiet floor). A piece starts at the first loud frame (with 240 ms
/// before it) and ends after 700 ms of quiet, or at 25 s.
pub struct Cutter { buf: Vec<f32>, piece: Vec<f32>, pre: Vec<f32>, floor: f32, speech_ms: usize, quiet_ms: usize, on: bool }
impl Default for Cutter { fn default() -> Self { Cutter { buf: vec![], piece: vec![], pre: vec![], floor: 0.003, speech_ms: 0, quiet_ms: 0, on: false } } }
impl Cutter {
    pub fn push(&mut self, s: &[f32]) -> Vec<Vec<f32>> {
        self.buf.extend_from_slice(s);
        let mut out = vec![];
        while self.buf.len() >= FRAME {
            let f: Vec<f32> = self.buf.drain(..FRAME).collect();
            let rms = (f.iter().map(|x| x * x).sum::<f32>() / FRAME as f32).sqrt();
            let loud = rms > (3.0 * self.floor).max(0.01);
            if !loud { self.floor = 0.95 * self.floor + 0.05 * rms.max(1e-5); }
            if !self.on {
                self.pre.extend_from_slice(&f);
                let keep = PRE_MS * RATE / 1000;
                if self.pre.len() > keep { let d = self.pre.len() - keep; self.pre.drain(..d); }
                if loud { self.on = true; self.piece = std::mem::take(&mut self.pre); self.speech_ms = 30; self.quiet_ms = 0; }
                continue;
            }
            self.piece.extend_from_slice(&f);
            if loud { self.speech_ms += 30; self.quiet_ms = 0; } else { self.quiet_ms += 30; }
            if self.quiet_ms >= PAUSE_MS || self.piece.len() >= MAX_PIECE_S * RATE {
                if let Some(p) = self.end() { out.push(p); }
            }
        }
        out
    }
    /// the piece so far (at mic off), if it holds speech
    pub fn end(&mut self) -> Option<Vec<f32>> {
        let p = std::mem::take(&mut self.piece);
        let ok = self.on && self.speech_ms >= MIN_SPEECH_MS;
        self.on = false; self.speech_ms = 0; self.quiet_ms = 0;
        ok.then_some(p)
    }
}

// --- text out: whisper.cpp, else the Windows speech engine -------------------------------------------------------------

pub enum Engine { Whisper(whisper_rs::WhisperContext), Os(String) }
pub fn load() -> Engine {
    let p = model_path();
    if !p.exists() { return Engine::Os(format!("no model at {}", p.display())); }
    let mut cp = whisper_rs::WhisperContextParameters::default();
    cp.use_gpu(false);
    match whisper_rs::WhisperContext::new_with_params(&p, cp) {
        Ok(c) => Engine::Whisper(c),
        Err(e) => Engine::Os(format!("whisper could not load the model: {e}")),
    }
}

/// whisper writes "[BLANK_AUDIO]", "(music)" and the like for no speech: never typed into a message
pub fn clean(t: &str) -> String {
    let mut out = String::new();
    let mut depth = 0;
    for c in t.chars() {
        match c { '[' | '(' => depth += 1, ']' | ')' => depth = (depth - 1).max(0), _ if depth == 0 => out.push(c), _ => {} }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub fn whisper_text(ctx: &whisper_rs::WhisperContext, s: &[f32]) -> Result<String, String> {
    let mut st = ctx.create_state().map_err(|e| e.to_string())?;
    let mut p = whisper_rs::FullParams::new(whisper_rs::SamplingStrategy::Greedy { best_of: 1 });
    p.set_language(Some("en"));
    p.set_n_threads(std::thread::available_parallelism().map(|n| n.get().min(4) as i32).unwrap_or(4));
    p.set_no_context(true);
    p.set_suppress_blank(true);
    p.set_print_special(false); p.set_print_progress(false); p.set_print_realtime(false); p.set_print_timestamps(false);
    // whisper needs at least 1 s; a shorter piece is padded with quiet
    let mut a = s.to_vec();
    if a.len() < RATE + RATE / 10 { a.resize(RATE + RATE / 10, 0.0); }
    st.full(p, &a).map_err(|e| e.to_string())?;
    let mut t = String::new();
    for seg in st.as_iter() {
        if seg.no_speech_probability() > 0.6 { continue; }
        t.push_str(&seg.to_str_lossy().map_err(|e| e.to_string())?);
        t.push(' ');
    }
    Ok(clean(&t))
}

#[cfg(target_os = "windows")]
pub fn os_text(s: &[f32]) -> Result<String, String> {
    use std::os::windows::process::CommandExt;
    let wav = std::env::temp_dir().join(format!("hayaku-voice-{}.wav", std::process::id()));
    {
        let spec = hound::WavSpec { channels: 1, sample_rate: RATE as u32, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
        let mut w = hound::WavWriter::create(&wav, spec).map_err(|e| e.to_string())?;
        for x in s { w.write_sample((x.clamp(-1.0, 1.0) * 32767.0) as i16).map_err(|e| e.to_string())?; }
        w.finalize().map_err(|e| e.to_string())?;
    }
    const SCRIPT: &str = "Add-Type -AssemblyName System.Speech; $e = New-Object System.Speech.Recognition.SpeechRecognitionEngine ([Globalization.CultureInfo]'en-US'); $e.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar)); $e.SetInputToWaveFile($env:HAYAKU_WAV); $t = @(); while ($r = $e.Recognize()) { $t += $r.Text }; $e.Dispose(); [Console]::Out.Write(($t -join ' '))";
    let out = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", SCRIPT])
        .env("HAYAKU_WAV", &wav)
        .creation_flags(0x0800_0000)   // no console window
        .output();
    let _ = std::fs::remove_file(&wav);   // the sound is deleted as soon as it is read
    let out = out.map_err(|e| e.to_string())?;
    if !out.status.success() { return Err(String::from_utf8_lossy(&out.stderr).chars().take(160).collect()); }
    Ok(clean(&String::from_utf8_lossy(&out.stdout)))
}
#[cfg(not(target_os = "windows"))]
pub fn os_text(_s: &[f32]) -> Result<String, String> {
    Err("the OS speech engine is not built for this system yet".into())
}

// --- the toggle ---------------------------------------------------------------------------------------------------------

fn worker(app: AppHandle, rx: Receiver<Vec<f32>>, stop: Arc<AtomicBool>, flush: Arc<AtomicBool>, done: Sender<()>) {
    let t0 = Instant::now();
    let mut eng = load();
    let load_ms = t0.elapsed().as_millis();
    let name = |e: &Engine| match e { Engine::Whisper(_) => "whisper".to_string(), Engine::Os(_) => "windows".to_string() };
    let why = match &eng { Engine::Os(w) => w.clone(), _ => String::new() };
    let _ = app.emit_to("main", "voice-state", json!({"on": true, "engine": name(&eng), "why": why, "loadMs": load_ms}));
    let mut cut = Cutter::default();
    let mut n = 0;
    let mut say = |piece: Vec<f32>, eng: &mut Engine| {
        let t = Instant::now();
        let res = match eng {
            Engine::Whisper(c) => whisper_text(c, &piece).or_else(|e| { *eng = Engine::Os(format!("whisper failed: {e}")); os_text(&piece) }),
            Engine::Os(_) => os_text(&piece),
        };
        n += 1;
        let (text, err) = match res { Ok(t) => (t, String::new()), Err(e) => (String::new(), e) };
        let _ = app.emit_to("main", "voice-text", json!({"text": text, "error": err, "engine": name(eng), "n": n,
            "audioMs": piece.len() * 1000 / RATE, "ms": t.elapsed().as_millis()}));
    };
    loop {
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(s) => for p in cut.push(&s) { if !stop.load(Ordering::SeqCst) || flush.load(Ordering::SeqCst) { say(p, &mut eng); } },
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
        if stop.load(Ordering::SeqCst) {
            for s in rx.try_iter() { if flush.load(Ordering::SeqCst) { for p in cut.push(&s) { say(p, &mut eng); } } }
            if flush.load(Ordering::SeqCst) { if let Some(p) = cut.end() { say(p, &mut eng); } }
            break;
        }
    }
    drop(eng);   // the model leaves memory with the mic
    let _ = app.emit_to("main", "voice-state", json!({"on": false, "pieces": n, "ms": t0.elapsed().as_millis()}));
    let _ = done.send(());
}

#[tauri::command]
pub async fn voice_start(app: AppHandle) -> Result<String, String> {
    let v: State<Voice> = app.state();
    if v.0.lock().unwrap().is_some() { return Ok("on".into()); }
    let stop = Arc::new(AtomicBool::new(false));
    let flush = Arc::new(AtomicBool::new(false));
    let (tx, rx) = mpsc::channel::<Vec<f32>>();
    let (rtx, rrx) = mpsc::channel();
    let s2 = stop.clone();
    match std::env::var("AVATAR_VOICE_TEST") {
        Ok(f) if !f.is_empty() => { std::thread::spawn(move || file_in(f, s2, tx, rtx)); }
        _ => { std::thread::spawn(move || mic(s2, tx, rtx)); }
    }
    let src = tauri::async_runtime::spawn_blocking(move || rrx.recv_timeout(Duration::from_secs(5)))
        .await.map_err(|e| e.to_string())?.map_err(|_| "the microphone did not answer".to_string())??;
    let (dtx, drx) = mpsc::channel();
    let (st, fl, a) = (stop.clone(), flush.clone(), app.clone());
    std::thread::spawn(move || worker(a, rx, st, fl, dtx));
    *v.0.lock().unwrap() = Some(Talk { stop, flush, done: drx });
    Ok(src)
}

/// flush: Send (the last piece is written before this returns); else Esc or the box closing (the rest is dropped)
#[tauri::command]
pub async fn voice_stop(app: AppHandle, flush: bool) -> Result<(), String> {
    let v: State<Voice> = app.state();
    let Some(t) = v.0.lock().unwrap().take() else { return Ok(()) };
    t.flush.store(flush, Ordering::SeqCst);
    t.stop.store(true, Ordering::SeqCst);
    tauri::async_runtime::spawn_blocking(move || { let _ = t.done.recv_timeout(Duration::from_secs(60)); })
        .await.map_err(|e| e.to_string())
}

#[tauri::command]
pub fn voice_on(app: AppHandle) -> bool {
    app.state::<Voice>().0.lock().unwrap().is_some()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn resampler_keeps_a_tone_and_the_length() {
        let tone: Vec<f32> = (0..48000).map(|i| (2.0 * std::f32::consts::PI * 440.0 * i as f32 / 48000.0).sin()).collect();
        let mut out = vec![];
        let mut r = Resampler::new(48000);
        for c in tone.chunks(480) { r.push(c, &mut out); }
        assert!((out.len() as i64 - 16000).abs() < 40, "{}", out.len());
        let rms = (out[1000..15000].iter().map(|x| x * x).sum::<f32>() / 14000.0).sqrt();
        assert!((rms - 0.7071).abs() < 0.02, "{rms}");
    }
    #[test]
    fn cutter_ends_a_piece_at_a_pause_and_drops_clicks() {
        let tone = |ms: usize| (0..ms * 16).map(|i| 0.3 * (i as f32 * 0.2).sin()).collect::<Vec<f32>>();
        let quiet = |ms: usize| vec![0.0f32; ms * 16];
        let mut c = Cutter::default();
        let mut got = c.push(&quiet(500));
        got.extend(c.push(&tone(60)));     // a click: too short
        got.extend(c.push(&quiet(900)));
        assert!(got.is_empty());
        got.extend(c.push(&tone(1200)));
        got.extend(c.push(&quiet(900)));
        assert_eq!(got.len(), 1);
        assert!(got[0].len() >= 1200 * 16);
    }
    #[test]
    fn clean_drops_no_speech_marks() {
        assert_eq!(clean(" [BLANK_AUDIO] Run the grip gate (music) on M24. "), "Run the grip gate on M24.");
    }
}
