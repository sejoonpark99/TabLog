//! tablog — Rust SDK for [tablogger](https://github.com/your-org/alt-tab)
//!
//! Sends structured log messages over WebSocket to the tablogger CLI server
//! running at `ws://localhost:4242` (or `TABLOG_PORT`). Falls back to
//! `println!` if the server is unreachable.
//!
//! # Quick start
//!
//! ```rust
//! use tablog::{tablog, warn, error, info};
//!
//! fn main() {
//!     tablog!("server started on port {}", 8080);
//!     warn!("cache miss for key {}", "user:42");
//!     error!("db connection failed: {}", "timeout");
//!     info!("shutting down");
//! }
//! ```
//!
//! Optionally call [`init`] at startup to set a custom source label:
//!
//! ```rust
//! tablog::init("my-api");
//! ```

use std::collections::VecDeque;
use std::net::TcpStream;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const DEFAULT_PORT: u16 = 4242;

// ── Global state ─────────────────────────────────────────────────────────────

struct State {
    source: String,
    port: u16,
    queue: Mutex<VecDeque<String>>,
}

static STATE: OnceLock<State> = OnceLock::new();
static THREAD_STARTED: AtomicBool = AtomicBool::new(false);

// ── Internal helpers ──────────────────────────────────────────────────────────

fn env_port() -> u16 {
    std::env::var("TABLOG_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(DEFAULT_PORT)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn start_worker(state: &'static State) {
    if THREAD_STARTED
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return;
    }
    thread::Builder::new()
        .name("tablog".into())
        .spawn(move || ws_worker(state))
        .expect("tablog: failed to spawn background thread");
}

/// Background daemon — maintains a persistent WebSocket connection and drains
/// the message queue. Reconnects with a 2-second backoff on failure.
fn ws_worker(state: &'static State) {
    let addr = format!("127.0.0.1:{}", state.port);
    let url = format!("ws://localhost:{}/", state.port);

    loop {
        let tcp = match TcpStream::connect(&addr) {
            Ok(s) => s,
            Err(_) => {
                thread::sleep(Duration::from_secs(2));
                continue;
            }
        };
        // Non-blocking reads so we can keep draining the queue.
        let _ = tcp.set_read_timeout(Some(Duration::from_millis(50)));

        let ws_result = tungstenite::client(url.as_str(), tcp);
        let (mut ws, _): (tungstenite::WebSocket<TcpStream>, _) = match ws_result {
            Ok(pair) => pair,
            Err(_) => {
                thread::sleep(Duration::from_secs(2));
                continue;
            }
        };

        // Drain queue while connected.
        'connected: loop {
            let msg = state.queue.lock().unwrap().pop_front();
            match msg {
                Some(json) => {
                    if ws
                        .send(tungstenite::Message::Text(json.clone().into()))
                        .is_err()
                    {
                        // Put it back so it isn't lost, then reconnect.
                        state.queue.lock().unwrap().push_front(json);
                        break 'connected;
                    }
                }
                None => {
                    // Nothing queued — yield briefly, then send a ping to
                    // keep the connection alive (mirrors Python SDK behaviour).
                    thread::sleep(Duration::from_millis(50));
                    if ws.send(tungstenite::Message::Ping(vec![].into())).is_err() {
                        break 'connected;
                    }
                    // Flush any incoming frames (pong etc.) to avoid buffer growth.
                    match ws.read() {
                        Err(tungstenite::Error::Io(e))
                            if e.kind() == std::io::ErrorKind::WouldBlock
                                || e.kind() == std::io::ErrorKind::TimedOut =>
                        {
                            // expected — no frame ready
                        }
                        Err(_) => break 'connected,
                        Ok(_) => {}
                    }
                }
            }
        }

        let _ = ws.close(None);
        thread::sleep(Duration::from_secs(2));
    }
}

fn ensure_init() -> &'static State {
    let state = STATE.get_or_init(|| State {
        source: "Rust".into(),
        port: env_port(),
        queue: Mutex::new(VecDeque::new()),
    });
    start_worker(state);
    state
}

// ── Public API ────────────────────────────────────────────────────────────────

/// Initialise tablog with a custom source label.
///
/// Optional — if not called, the source defaults to `"Rust"` and the port is
/// read from `TABLOG_PORT` (default `4242`).
///
/// Call this once at application startup before the first log macro.
pub fn init(source: &str) {
    init_with_port(source, env_port());
}

/// Like [`init`] but also overrides the port.
pub fn init_with_port(source: &str, port: u16) {
    let state = STATE.get_or_init(|| State {
        source: source.into(),
        port,
        queue: Mutex::new(VecDeque::new()),
    });
    start_worker(state);
    let _ = (source, port); // already set via get_or_init — ignore if called twice
}

/// Low-level send — called by the log macros. Public so crates that wrap
/// tablog can emit events without going through the macros.
pub fn send_log(level: &str, message: String, file: Option<&str>, line: Option<u32>) {
    let state = ensure_init();

    // Mirror the Python SDK: always echo to stdout as a fallback / convenience.
    println!("[{}] {}", state.source, message);

    let json = serde_json::json!({
        "type": "log",
        "source": state.source,
        "message": message,
        "level": level,
        "timestamp": now_ms(),
        "file": file,
        "line": line,
    })
    .to_string();

    state.queue.lock().unwrap().push_back(json);
}

// ── Macros ────────────────────────────────────────────────────────────────────

/// Send a `log`-level message to tablogger.
///
/// Accepts the same format string syntax as [`println!`].
///
/// ```rust
/// tablog::tablog!("user {} logged in", user_id);
/// ```
#[macro_export]
macro_rules! tablog {
    ($($arg:tt)*) => {
        $crate::send_log("log", format!($($arg)*), Some(file!()), Some(line!()))
    };
}

/// Send a `warn`-level message to tablogger.
#[macro_export]
macro_rules! warn {
    ($($arg:tt)*) => {
        $crate::send_log("warn", format!($($arg)*), Some(file!()), Some(line!()))
    };
}

/// Send an `error`-level message to tablogger.
#[macro_export]
macro_rules! error {
    ($($arg:tt)*) => {
        $crate::send_log("error", format!($($arg)*), Some(file!()), Some(line!()))
    };
}

/// Send an `info`-level message to tablogger.
#[macro_export]
macro_rules! info {
    ($($arg:tt)*) => {
        $crate::send_log("info", format!($($arg)*), Some(file!()), Some(line!()))
    };
}
