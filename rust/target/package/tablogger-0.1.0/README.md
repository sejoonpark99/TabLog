# tablog

Rust SDK for [tablogger](https://github.com/your-org/alt-tab) — one function, every language, one terminal.

`tablog!()` is a drop-in replacement for `println!()` that routes your logs to a single unified terminal alongside your JS/Python services. Run `npx tablogger` once and see everything in one place.

```
[React]    button clicked
[FastAPI]  GET /api/users 200 18ms
[Rust]     processing 42 items       main.rs:18
[Rust]     done in 4ms               main.rs:31
```

[![Crates.io](https://img.shields.io/crates/v/tablog)](https://crates.io/crates/tablog)
[![license](https://img.shields.io/badge/license-MIT-blue)](#license)

---

## Installation

```bash
cargo add tablogger
```

Or in `Cargo.toml`:

```toml
[dependencies]
tablogger = "0.1"
```

---

## Quick start

**1. Start the terminal**

```bash
npx tablogger
```

**2. Log from Rust**

```rust
use tablog::{tablog, warn, error, info};

fn main() {
    tablog::init("my-api"); // optional — sets the source label, defaults to "Rust"

    tablog!("server started on port {}", 8080);
    info!("connected to database");
    warn!("cache miss for key {}", "user:42");
    error!("request failed: {}", "timeout");
}
```

Logs appear instantly in the tablogger terminal with source label, level color, file, and line number.

---

## API

### `tablog::init(source)`

Call once at startup to set a custom source label. Optional — defaults to `"Rust"`.

```rust
tablog::init("payments-service");
```

To also override the port (default `4242`, or `TABLOG_PORT` env var):

```rust
tablog::init_with_port("payments-service", 4242);
```

### Macros

| Macro | Level | Color in terminal |
|-------|-------|-------------------|
| `tablog!(...)` | log | white |
| `info!(...)` | info | blue |
| `warn!(...)` | warn | yellow |
| `error!(...)` | error | red |

All macros accept the same format string syntax as `println!()` and automatically capture the source file and line number.

---

## Behaviour

- **Fire and forget** — macros return immediately; sending is async in a background thread.
- **Auto-reconnect** — if the tablogger server isn't running yet, messages queue up and flush once it starts.
- **Fallback** — always echoes to stdout via `println!` even when the server is unreachable.
- **No async runtime required** — uses a plain background thread, works in any Rust app.

---

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TABLOG_PORT` | `4242` | Port of the tablogger server |

---

## License

MIT
