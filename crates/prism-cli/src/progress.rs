//! Renders core progress events as a 4-line loader on stderr: a tumbling
//! braille tetrahedron beside the item being worked on, a blank line, and
//! up to two progress rows (the first counter still open and the most
//! recently opened one), each as a label column, a heavy-rule bar with a
//! half-cell head, and a percentage or item count. Indeterminate counters
//! get a bouncing comet on the same rail. Falls back to plain line output
//! when stderr is not a terminal.
//!
//! Windows console fonts are not reliable braille renderers, so on Windows
//! and inside WSL the loader is all-ASCII. PRISM_ASCII=1 or =0 forces the
//! choice on any platform.

use std::io::{IsTerminal, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use prism_core::{Event, ProgressObserver};

use crate::out::errln;
use crate::tetra;

const REGION_H: usize = tetra::H + 1; // loader lines: one blank, then the spinner rows
const BARW: usize = 30; // bar columns
const LABELW: usize = 14; // label column width; longer labels truncate
const TAILW: usize = 9; // progress figure column, right-aligned ("9999/9999", " 100%")
const BATCHW: usize = 58; // truncation budget for the item line
const FRAME_US: u64 = 16_667; // 60fps

// Render with ASCII-safe glyphs only (see the module docs). Set once at
// observer creation, read wherever glyphs are chosen.
static ASCII_MODE: AtomicBool = AtomicBool::new(false);

fn ascii_mode() -> bool {
    ASCII_MODE.load(Ordering::Relaxed)
}

// WSL runs Linux binaries in a Windows console with the same font limits.
fn wsl() -> bool {
    if !cfg!(target_os = "linux") {
        return false;
    }
    std::env::var_os("WSL_DISTRO_NAME").is_some()
        || std::fs::read_to_string("/proc/sys/kernel/osrelease")
            .map(|v| v.to_ascii_lowercase().contains("microsoft"))
            .unwrap_or(false)
}

struct Counter {
    id: u64,
    label: String,
    unit: String,
    total: Option<f64>,
    count: f64,
}

#[derive(Default)]
struct State {
    batch: Option<String>,
    counters: Vec<Counter>,
    /// The last secondary counter to finish, shown full on the second row
    /// while newer counters have nothing to show yet.
    done: Option<Counter>,
    pending: Vec<String>, // messages to scroll out above the loader
}

pub struct LoaderObserver {
    tty: bool,
    state: Arc<Mutex<State>>,
    running: Arc<AtomicBool>,
    thread: Mutex<Option<JoinHandle<()>>>,
}

// The Windows console interprets VT sequences only once
// ENABLE_VIRTUAL_TERMINAL_PROCESSING is set (Windows Terminal and WSL windows
// have it on already, legacy conhost does not). No console mode to speak of
// elsewhere.
#[cfg(windows)]
fn enable_vt() -> bool {
    type Handle = *mut core::ffi::c_void;
    const STD_ERROR_HANDLE: u32 = -12i32 as u32;
    const ENABLE_VIRTUAL_TERMINAL_PROCESSING: u32 = 0x0004;
    extern "system" {
        fn GetStdHandle(n: u32) -> Handle;
        fn GetConsoleMode(h: Handle, mode: *mut u32) -> i32;
        fn SetConsoleMode(h: Handle, mode: u32) -> i32;
    }
    unsafe {
        let h = GetStdHandle(STD_ERROR_HANDLE);
        let mut mode = 0u32;
        if GetConsoleMode(h, &mut mode) == 0 {
            return false;
        }
        if mode & ENABLE_VIRTUAL_TERMINAL_PROCESSING != 0 {
            return true;
        }
        SetConsoleMode(h, mode | ENABLE_VIRTUAL_TERMINAL_PROCESSING) != 0
    }
}

#[cfg(not(windows))]
fn enable_vt() -> bool {
    true
}

impl LoaderObserver {
    pub fn new() -> Self {
        let ascii = match std::env::var("PRISM_ASCII").ok().as_deref() {
            Some("1") => true,
            Some("0") => false,
            _ => cfg!(windows) || wsl(),
        };
        ASCII_MODE.store(ascii, Ordering::Relaxed);
        let tty = std::io::stderr().is_terminal() && enable_vt();
        let state = Arc::new(Mutex::new(State::default()));
        let running = Arc::new(AtomicBool::new(true));
        let thread = tty.then(|| {
            let (state, running) = (state.clone(), running.clone());
            std::thread::spawn(move || draw_loop(state, running))
        });
        LoaderObserver { tty, state, running, thread: Mutex::new(thread) }
    }

    pub fn batch(&self, index: u64, total: u64, name: &str) {
        if self.tty {
            let label = if total > 1 {
                format!("[{}/{}] {}", index + 1, total, name)
            } else {
                name.to_string()
            };
            let mut st = self.state.lock().unwrap();
            st.batch = Some(crate::out::terminal_text(&label).replace('\n', "\\n").replace('\t', "\\t"));
            st.done = None; // a finished bar never outlives its batch item
        } else if total > 1 {
            errln!("[{}/{}] {}", index + 1, total, name);
        }
    }

    /// Log a line in plain mode only. The tty loader carries the same
    /// information in its counter rows, so it stays quiet there.
    pub fn plain(&self, text: String) {
        if !self.tty {
            errln!("{text}");
        }
    }

    pub fn finish(&self) {
        self.running.store(false, Ordering::SeqCst);
        if let Some(t) = self.thread.lock().unwrap().take() {
            let _ = t.join();
        }
    }
}

impl Drop for LoaderObserver {
    fn drop(&mut self) {
        self.finish();
    }
}

impl ProgressObserver for LoaderObserver {
    fn on_event(&self, ev: Event) {
        match ev {
            Event::CounterOpen { id, label, unit, total } => {
                if self.tty {
                    let mut st = self.state.lock().unwrap();
                    let label = crate::out::terminal_text(&label).replace('\n', "\\n").replace('\t', "\\t");
                    st.counters.push(Counter { id, label, unit, total, count: 0.0 });
                }
            }
            Event::Progress { id, count } => {
                if self.tty {
                    let mut st = self.state.lock().unwrap();
                    if let Some(c) = st.counters.iter_mut().find(|c| c.id == id) {
                        c.count = count;
                    }
                }
            }
            Event::CounterClose { id } => {
                if self.tty {
                    let mut st = self.state.lock().unwrap();
                    if let Some(pos) = st.counters.iter().position(|c| c.id == id) {
                        let c = st.counters.remove(pos);
                        // A finished secondary counter lingers on the second
                        // row, pinned at full, until something overtakes it.
                        if pos > 0 {
                            if let Some(total) = c.total.filter(|t| *t > 0.0) {
                                st.done = Some(Counter { count: total, ..c });
                            }
                        }
                    }
                }
            }
            Event::Message(m) => {
                if self.tty {
                    self.state.lock().unwrap().pending.push(crate::out::terminal_text(&m));
                } else {
                    errln!("{m}");
                }
            }
            Event::BatchItem { index, total, name } => {
                self.batch(index, total, &name);
            }
        }
    }
}

fn draw_loop(state: Arc<Mutex<State>>, running: Arc<AtomicBool>) {
    let t0 = Instant::now();
    let frame_dt = Duration::from_micros(FRAME_US);
    let mut next = t0 + frame_dt;
    let mut drawn = false;
    let stderr = std::io::stderr();

    while running.load(Ordering::SeqCst) {
        let t = t0.elapsed().as_secs_f32();
        let mut buf = String::new();
        {
            let mut st = state.lock().unwrap();
            // hold the first frame briefly so instant (cached) items don't flash
            if !drawn && st.counters.is_empty() && t < 0.08 {
                drop(st);
                std::thread::sleep(Duration::from_millis(5));
                continue;
            }
            if drawn {
                buf.push_str(&format!("\x1b[{REGION_H}F")); // top of the loader
            }
            for m in st.pending.drain(..) {
                buf.push_str("\r\x1b[2K");
                buf.push_str(&m);
                buf.push('\n');
            }
            compose(&st, t, &mut buf);
        }
        drawn = true;
        {
            let mut out = stderr.lock();
            let _ = out.write_all(buf.as_bytes());
            let _ = out.flush();
        }

        let now = Instant::now();
        if next > now {
            std::thread::sleep(next - now);
        } else {
            next = now; // don't burst to catch up after the first-frame hold
        }
        next += frame_dt;
    }

    // scroll out any last messages and take the loader down
    let mut buf = String::new();
    if drawn {
        buf.push_str(&format!("\x1b[{REGION_H}F"));
    }
    for m in state.lock().unwrap().pending.drain(..) {
        buf.push_str("\r\x1b[2K");
        buf.push_str(&m);
        buf.push('\n');
    }
    if drawn {
        buf.push_str("\x1b[J");
    }
    if !buf.is_empty() {
        let mut out = stderr.lock();
        let _ = out.write_all(buf.as_bytes());
        let _ = out.flush();
    }
}

// The four loader lines: spinner cells, then title / current item / bars.
// Every line is \x1b[2K-cleared before writing, so no padding is needed.
fn compose(st: &State, t: f32, buf: &mut String) {
    let spin = tetra::frame(t, ascii_mode());
    buf.push_str("\r\x1b[2K\n"); // blank line separating the loader from prior output
    // Second row: the newest secondary counter once it has progress to show,
    // otherwise the last one to finish (pinned at full), so with many quick
    // items the row tails completions instead of idling at zero.
    let second = match st.counters.last() {
        Some(last) if st.counters.len() > 1 && (last.count > 0.0 || st.done.is_none()) => {
            Some(counter_line(last, t))
        }
        Some(_) => st.done.as_ref().map(|c| counter_line(c, t)),
        None => None,
    };
    let texts: [String; tetra::H] = [
        st.batch.as_deref().map(|s| truncate(s, BATCHW)).unwrap_or_default(),
        String::new(),
        st.counters.first().map(|c| counter_line(c, t)).unwrap_or_default(),
        second.unwrap_or_default(),
    ];
    for (line, text) in spin.iter().zip(texts.iter()) {
        buf.push_str("\r\x1b[2K");
        buf.push_str(line);
        buf.push_str("  ");
        buf.push_str(text);
        buf.push('\n');
    }
}

// Byte counters read best as a percentage, item counters (files, blobs) as
// the k/n they actually are.
fn counter_line(c: &Counter, t: f32) -> String {
    let label = truncate(&c.label, LABELW);
    match c.total {
        Some(total) if total > 0.0 => {
            let frac = (c.count / total).clamp(0.0, 1.0) as f32;
            let tail = if c.unit == "B" {
                format!("{}%", (frac * 100.0) as u32)
            } else {
                format!("{}/{}", c.count.min(total) as u64, total as u64)
            };
            format!("{label:<LABELW$} {} {tail:>TAILW$}", bar(frac))
        }
        _ => format!("{label:<LABELW$} {}", sweep(t)),
    }
}

// Heavy rule with a half-cell head, empty missing. ASCII mode draws a plain
// equals rule with no head.
fn bar(frac: f32) -> String {
    let n = (frac * BARW as f32) as usize;
    if ascii_mode() {
        let mut s = "=".repeat(n);
        s.push_str(&" ".repeat(BARW - n));
        return s;
    }
    let mut s = "━".repeat(n);
    if n < BARW {
        s.push('╸');
        s.push_str(&" ".repeat(BARW - n - 1));
    }
    s
}

// Indeterminate counters: a 3-cell comet bouncing along the same rail.
fn sweep(t: f32) -> String {
    let span = (BARW - 3) as f32;
    let phase = (t * 0.7).fract() * 2.0;
    let p = if phase < 1.0 { phase } else { 2.0 - phase };
    let p = (p * span) as usize;
    let mut s = " ".repeat(p);
    s.push_str(if ascii_mode() { "===" } else { "╺━╸" });
    s.push_str(&" ".repeat(BARW - p - 3));
    s
}

// Middle truncation is not worth the fuss; keep the tail, which carries the
// filename.
fn truncate(s: &str, max: usize) -> String {
    let n = s.chars().count();
    if n <= max {
        return s.to_string();
    }
    if ascii_mode() {
        let tail: String = s.chars().skip(n - (max - 2)).collect();
        format!("..{tail}")
    } else {
        let tail: String = s.chars().skip(n - (max - 1)).collect();
        format!("…{tail}")
    }
}
