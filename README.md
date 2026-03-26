# tablogger

One function. Every language. One terminal.

`tablog()` is a drop-in replacement for `console.log` / `print()` that routes all logs — frontend, backend, any framework — to a single unified terminal. Run `npx tablogger` once and see everything in one place: colored source labels, network request tracking, log levels, split view, and a full HTTP API for querying your logs programmatically.

```bash
npx tablogger
```

```
[React]    button clicked (×3)
[React]    out  GET  /api/users              200     22ms   1.2kB
[FastAPI]  in   GET  /api/users              200     18ms   1.2kB  <> React
[FastAPI]  fetching users from db                                   main.py:42
[Rust]     processed 42 items                                       main.rs:18
```

[![npm](https://img.shields.io/npm/v/tablogger)](https://www.npmjs.com/package/tablogger)
[![PyPI](https://img.shields.io/pypi/v/tablog)](https://pypi.org/project/tablog/)
[![Crates.io](https://img.shields.io/crates/v/tablogger)](https://crates.io/crates/tablogger)
[![license](https://img.shields.io/badge/license-MIT-blue)](#license)

---

## Claude Code integration

When you run `npx tablogger`, it automatically writes a live API reference into your project's `CLAUDE.md`. Claude Code reads this on every prompt — so Claude and its agents can query your logs, errors, traces, and slow requests directly as part of debugging, without any extra setup.

```
You:     "why is /api/users slow?"
Claude:  [curls localhost:4242/slow]
         [curls localhost:4242/trace?url=/api/users]
         "The FastAPI handler is taking 1.2s — tablog shows it's the db query on main.py:38"
```

When you Ctrl+C tablogger, the section is removed and `CLAUDE.md` is restored.

---

## Installation

### JavaScript / TypeScript

```bash
npm install tablogger
```

### Python

```bash
pip install tablog
```

### Rust

```bash
cargo add tablogger
```

---

## Quick start

**1. Start the terminal**

```bash
npx tablogger
```

**2. Add to your JS app**

```js
import { tablog } from 'tablogger'

tablog('user logged in')
tablog('query result:', { rows: 42 })
```

**3. Add to your Python app**

```python
from tablog import tablog

tablog('server started')
tablog('query result:', {'rows': 42})
```

**4. Add to your Rust app**

```rust
use tablog::{tablog, warn, error, info};

tablog!("server started on port {}", 8080);
warn!("cache miss for key {}", "user:42");
```

Everything streams to the same terminal, labeled by source.

---

## Features

### Unified terminal for every service

All logs from React, Express, FastAPI, Flask, or any Node/Python service appear in one place with colored `[Source]` labels — no tab-switching.

### Network request tracking

Frontend outgoing requests and backend incoming requests are captured automatically and shown in a compact line:

```
[React]    out  GET  /api/users   200   22ms   1.2kB
[FastAPI]  in   GET  /api/users   200   18ms         <> React
```

Status codes are color-coded (green/cyan/yellow/red) and slow requests (>500ms) are highlighted in red.

### Request correlation

When a React `fetch()` and a FastAPI handler serve the same request, tablogger links them with `<> React` — no headers injected, no CORS issues. Matched by `METHOD + path` within a 3-second window.

### Caller file + line (Python)

Every Python `tablog()` call shows the file and line number it was called from:

```
[FastAPI]  fetching users from db    main.py:38
[FastAPI]  returning 3 users         main.py:41
```

### Log levels

```python
tablog('all good')                        # default
tablog('cache miss rate high', level='warn')   # yellow
tablog('payment failed', level='error')        # red ●
```

### Split view

```
/split 2
```

Shows two services side-by-side in the terminal. Use Tab to switch focus, arrow keys to scroll each column independently.

```
┌── React ─────────────────┬── FastAPI ────────────────┐
│ button clicked (×1)      │ fetching users from db    │
│ out GET /api/users  200  │ in  GET /api/users  200   │
│ button clicked (×2)      │ returning 3 users         │
└──────────────────────────┴───────────────────────────┘
```

### HTTP log API

Query your live log stream from any tool — curl, LLM, CI script:

```bash
curl localhost:4242/logs             # all recent logs
curl localhost:4242/errors           # errors + 5xx only
curl localhost:4242/slow?ms=200      # requests over 200ms
curl localhost:4242/search?q=userId  # full-text search
curl localhost:4242/trace?url=/api/users   # full request trace
curl localhost:4242/sources          # per-source health
curl localhost:4242/timeline?since=5m
curl localhost:4242/repeat?min=3     # repeated messages
```

Add `?format=text` to any endpoint for plain-text output (no ANSI codes).

### RAG / LLM pipeline visibility

```python
from tablog.langchain import TablogCallbackHandler

handler = TablogCallbackHandler()
```

```
[RAGApp]  retrieve  "what is the refund policy?"  5 results  top=0.91  38ms
[RAGApp]  rerank    10→3 results  12ms
[RAGApp]  prompt    2100 tokens  3 chunks
[RAGApp]  generate  gpt-4o  1240ms  2100→187 tokens
```

Query quality issues via the API:

```bash
curl localhost:4242/rag/quality   # low scores, truncated context, slow generation
curl localhost:4242/rag/slow      # slowest pipeline steps
```

### Session export

```
/export
```

Saves the full session to `tablog-YYYYMMDD-HHMMSS.json` (structured) and `.log` (human-readable, ANSI stripped).

---

## Usage

### JavaScript / TypeScript

```js
import { tablog } from 'tablogger'

tablog('user logged in')
tablog('query result:', { rows: 42 })
```

#### React / browser

```js
import { tablog, init } from 'tablogger'

// Call once at app entry point
init({ source: 'React', network: true })

tablog('component mounted')
```

`network: true` intercepts all `fetch` and `XHR` calls automatically.

#### Express / Node.js

```js
import { tablog, expressMiddleware } from 'tablogger'

app.use(expressMiddleware())   // captures all incoming requests

app.get('/api/users', (req, res) => {
  tablog('fetching users')
  res.json({ users })
})
```

### Python

```python
from tablog import tablog

tablog('server started')
tablog('query result:', {'rows': 42})
```

#### FastAPI

```python
from tablog import tablog
from tablog.middleware import TablogMiddleware

app.add_middleware(TablogMiddleware, source='FastAPI')

@app.get('/api/users')
async def get_users():
    tablog('fetching users')
    return {'users': users}
```

#### Flask

```python
from tablog.middleware import TablogFlaskMiddleware

TablogFlaskMiddleware(app)
```

### Rust

```rust
use tablog::{tablog, warn, error, info};

fn main() {
    tablog::init("my-api"); // optional — defaults to "Rust"

    tablog!("server started on port {}", 8080);
    info!("connected to database");
    warn!("cache miss for key {}", "user:42");
    error!("request failed: {}", "timeout");
}
```

#### LangChain

```python
from tablog.langchain import TablogCallbackHandler

handler = TablogCallbackHandler(source='MyRAGApp')
chain = RetrievalQA.from_chain_type(llm=llm, callbacks=[handler])
```

---

## CLI commands

Start the server:

```bash
npx tablogger
```

| Command | Description |
|---------|-------------|
| `/tab 1` | Focus on service 1 only |
| `/tab 2` | Focus on service 2 only |
| `/tab all` | Show all sources |
| `/split 2` | Side-by-side split view |
| `/split off` | Exit split view |
| `/change` | Interactive filter menu (toggle sources, log/network) |
| `/copy` | Copy recent logs to clipboard |
| `/export` | Save session to `.json` + `.log` |

---

## How it works

```
┌─────────────┐    tablog()     ┌──────────────────────┐
│  React app  │ ──────────────► │                      │
│  (browser)  │   WebSocket     │  tablogger terminal  │
└─────────────┘                 │  ws://localhost:4242 │
                                │  http://localhost:4242│
┌─────────────┐    tablog()     │                      │
│  FastAPI    │ ──────────────► │  [React]   click     │
│  (Python)   │   WebSocket     │  [FastAPI] query     │
└─────────────┘                 │  [Rust]    started   │
                                │                      │
┌─────────────┐    tablog!()    │                      │
│  Rust app   │ ──────────────► │                      │
└─────────────┘   WebSocket     └──────────────────────┘
```

- `npx tablogger` starts a WebSocket + HTTP server on port 4242
- Every `tablog()` call sends a JSON message over WebSocket
- The CLI renders messages with colored `[Source]` labels
- Network middleware captures HTTP request/response metadata on both sides
- Frontend `out` requests are correlated with backend `in` responses

---

## Configuration

`tablog.config.json` is auto-generated on first run (gitignored):

```json
{
  "services": [
    { "name": "Vite",    "port": 5173, "role": "frontend" },
    { "name": "FastAPI", "port": 8000, "role": "backend"  }
  ]
}
```

Delete it and re-run `npx tablogger` to re-detect services.

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TABLOG_PORT` | `4242` | WebSocket + HTTP server port |
| `TABLOG_SOURCE` | auto-detected | Override source label |

---

## License

MIT
