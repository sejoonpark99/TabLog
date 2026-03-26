# Architecture

## Overview

```
┌──────────────────────────────────────────────────────┐
│                   Your applications                  │
│                                                      │
│  ┌─────────────┐          ┌──────────────────────┐  │
│  │ React / Vue │          │ FastAPI / Express     │  │
│  │ (browser)   │          │ (Node.js / Python)   │  │
│  │             │          │                      │  │
│  │  tablog()   │          │  tablog()            │  │
│  │  init({     │          │  TablogMiddleware     │  │
│  │   network:  │          │                      │  │
│  │   true })   │          │                      │  │
│  └──────┬──────┘          └──────────┬───────────┘  │
│         │  WebSocket                  │ WebSocket    │
└─────────┼─────────────────────────────┼─────────────┘
          │                             │
          ▼                             ▼
    ┌─────────────────────────────────────────┐
    │           tablog server                 │
    │         ws://localhost:4242             │
    │                                         │
    │  • receives JSON messages               │
    │  • correlates frontend ↔ backend reqs  │
    │  • applies source filters              │
    │  • formats + renders to terminal        │
    └─────────────────────────────────────────┘
```

---

## Message protocol

All clients send JSON over WebSocket. Two message types:

### Log message

```json
{
  "type": "log",
  "source": "React",
  "message": "button clicked",
  "level": "log",
  "timestamp": 1711480000000
}
```

`level` is one of `log` (default) · `warn` · `error` · `info`.

### Network message

```json
{
  "type": "network",
  "source": "React",
  "method": "GET",
  "url": "/api/users",
  "status": 200,
  "duration": 22,
  "requestSize": 0,
  "responseSize": 1234,
  "direction": "outgoing",
  "timestamp": 1711480000000
}
```

`direction` is `"outgoing"` (frontend → server) or `"incoming"` (server receiving request).

---

## Source files

```
src/
├── cli.ts         Orchestrator — starts server, handles stdin commands, renders output
├── server.ts      WebSocket server wrapper (ws package)
├── formatter.ts   All terminal rendering — log levels, network columns, banner, separators
├── filter.ts      Filter state (/change menu) + focused source (/tab)
├── export.ts      Session buffer + /export file writer
├── setup.ts       Port scanner, service detector, PID lookup, setup wizard
├── network.ts     NetworkMessage type, browser fetch/XHR interceptors, Express middleware
├── detector.ts    Auto-detect framework from DOM / require.cache
└── index.ts       Public API — tablog(), init(), expressMiddleware()
```

```
python/tablog/
├── __init__.py    tablog() function, WebSocket daemon thread, queue
├── detector.py    Auto-detect framework from sys.modules
└── middleware.py  ASGI (FastAPI/Starlette) + WSGI (Flask) middleware
```

---

## Request correlation

Frontend outgoing requests and backend incoming requests are linked without modifying HTTP headers (which would trigger CORS preflight).

**Algorithm:**

1. A frontend `fetch('/api/users')` intercepted by `init({ network: true })` sends a network message with `direction: "outgoing"`, stored in `pendingOutgoing` keyed by `"GET:/api/users"`.
2. FastAPI handles `GET /api/users`, `TablogMiddleware` sends a network message with `direction: "incoming"`.
3. The CLI matches `"GET:/api/users"` in `pendingOutgoing` within a 3-second window.
4. The backend log line renders with `↔ React` appended.

Entries expire after 3 seconds to prevent memory creep.

---

## Port detection (setup wizard)

1. **TCP probe** — 15 common ports probed in parallel (400ms timeout each, both IPv4 `127.0.0.1` and IPv6 `::1`).
2. **HTTP identification** — for each open port, fetch `http://localhost:{port}/` and inspect:
   - `Server` header: `uvicorn` → FastAPI, `werkzeug` → Flask, etc.
   - `X-Powered-By` header: `Express`, `Next.js`
   - `/__vite_ping` endpoint → Vite
   - `/_next/static/` with 200/403 → Next.js
   - Content-type + port heuristics as fallback
3. **PID lookup** — single `netstat -ano` (Windows) or `ss`/`lsof` (Unix) call maps port → PID.

---

## Build

```bash
npm run build   # produces dist/
```

Three tsup targets:
- `dist/cli.js` — Node.js CJS bundle with `#!/usr/bin/env node` shebang
- `dist/index.js` + `dist/index.mjs` — CJS + ESM client library
- `dist/browser.global.js` — IIFE bundle, exposes `window.Tablog`
