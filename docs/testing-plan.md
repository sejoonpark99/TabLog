# Testing Plan

## Overview

This document covers manual and automated testing for every feature in tablog. Tests are grouped
by subsystem. For each test, the expected output and any known edge cases are documented.

Run the test server before starting:

```bash
# Terminal 1 — tablog server
npm start

# Terminal 2 — test Express backend
node test/server.js

# Terminal 3 — test React frontend
cd test/react-frontend && npm run dev
```

---

## 1. Core Logging

### 1.1 Python `tablog()`

**Setup:** `from tablog import tablog`

| # | Test | Command | Expected |
|---|------|---------|----------|
| 1.1.1 | Basic string | `tablog("hello world")` | `[FastAPI]  hello world  main.py:5` in terminal |
| 1.1.2 | Multiple args | `tablog("query:", {"rows": 42})` | args space-joined, dict serialized as JSON |
| 1.1.3 | No args | `tablog()` | empty message line, no crash |
| 1.1.4 | Unicode | `tablog("résumé 日本語 🔥")` | displays correctly in terminal and JSON export |
| 1.1.5 | Very long message | `tablog("x" * 5000)` | wraps in terminal, full string in JSON |
| 1.1.6 | Non-serializable arg | `tablog("obj:", object())` | falls back to `repr()`, no crash |
| 1.1.7 | Before server starts | Call `tablog()` with no server running | message queued locally, sent when server comes up |
| 1.1.8 | Server never starts | `tablog()` with server permanently absent | falls back to `print()` only, no hang, no crash |
| 1.1.9 | Rapid fire | `for i in range(1000): tablog(i)` | all 1000 arrive in order, none dropped |

**Edge cases:**

- **Wrapper pattern** — if the user wraps `tablog()` in their own function, `file` and `line` will
  point to the wrapper, not the original call site. This is expected behavior; document it.

  ```python
  def log(msg):
      tablog(msg)      # file="helpers.py", line=2 — not the caller of log()

  log("oops")          # user expects helpers.py:6, gets helpers.py:2
  ```

- **REPL / exec** — `tablog()` called from the Python REPL or `exec()` will produce
  `file="<stdin>"` or `file="<string>"`. These should display as-is without crashing.

- **Thread safety** — `tablog()` from multiple threads simultaneously should not corrupt the
  queue. The `_queue` is a `threading.Queue` which is thread-safe by design, but verify no
  interleaved output.

### 1.2 JavaScript `tablog()`

| # | Test | Command | Expected |
|---|------|---------|----------|
| 1.2.1 | Node.js basic | `tablog("hello")` from Express app | message in terminal |
| 1.2.2 | Browser basic | `tablog("click")` from React component | message in terminal |
| 1.2.3 | Multiple args | `tablog("user:", {id: 1})` | serialized and joined |
| 1.2.4 | Before `init()` | Call without explicit `init()` | auto-inits on first call |
| 1.2.5 | Custom source | `init({ source: "MyApp" })` then `tablog("x")` | `[MyApp]` label |
| 1.2.6 | Custom port | `init({ port: 9000 })` | connects to port 9000 |

---

## 2. Terminal Display

### 2.1 Log Level Colors

| # | Test | Expected |
|---|------|----------|
| 2.1.1 | `level: "error"` | red text, `●` prefix |
| 2.1.2 | `level: "warn"` | yellow text |
| 2.1.3 | `level: "info"` | dim text |
| 2.1.4 | `level: "log"` or absent | default terminal color |

### 2.2 Message Wrapping

| # | Test | Expected |
|---|------|----------|
| 2.2.1 | Message fits on one line | no wrapping |
| 2.2.2 | Message wider than terminal | wraps at column boundary, continuation indented under message start (not under label) |
| 2.2.3 | Message contains embedded newlines | each newline becomes a wrapped continuation |
| 2.2.4 | Terminal width = 0 or undefined | `wrapMessage` returns text unwrapped, no crash |
| 2.2.5 | Resize terminal mid-session | subsequent lines use new width; prior lines unchanged |

### 2.3 Caller Location Suffix

| # | Test | Expected |
|---|------|----------|
| 2.3.1 | `file` + `line` present | dim `filename.py:42` at end of log line |
| 2.3.2 | `file` absent | no suffix, no `:undefined` or `:null` rendered |
| 2.3.3 | `file` is a full path | only `os.path.basename()` displayed (e.g., `main.py` not `/home/user/app/main.py`) |
| 2.3.4 | `file` = `<stdin>` | displayed as-is |
| 2.3.5 | JS log message (no `file` field) | no suffix shown |

### 2.4 Network Line Colors

| # | Test | Expected |
|---|------|----------|
| 2.4.1 | `status: 200` | green |
| 2.4.2 | `status: 301` | cyan |
| 2.4.3 | `status: 404` | yellow |
| 2.4.4 | `status: 500` | red |
| 2.4.5 | `status: 0` (error/no response) | red `ERR` |
| 2.4.6 | `duration < 200ms` | dim |
| 2.4.7 | `duration 200–500ms` | yellow |
| 2.4.8 | `duration > 500ms` | red |
| 2.4.9 | URL exactly 40 chars | no truncation |
| 2.4.10 | URL > 40 chars | truncated with `…` at char 39 |

### 2.5 RAG Event Display

```
[MyRAGApp]  retrieve  "what is the refund policy?"  5 results  top=0.91  38ms
[MyRAGApp]  rerank    10→3 results  12ms
[MyRAGApp]  prompt    2100 tokens  3 chunks
[MyRAGApp]  generate  gpt-4o  1240ms  2100→187 tokens
```

| # | Test | Expected |
|---|------|----------|
| 2.5.1 | `event: "retrieve"` | `retrieve` in cyan, query in dim quotes, count, `top=N` |
| 2.5.2 | `topScore < 0.7` | result count in yellow (low confidence warning) |
| 2.5.3 | `topScore: null` | no `top=` field shown |
| 2.5.4 | `event: "rerank"` | `inputCount→outputCount results  Nms` |
| 2.5.5 | `event: "prompt"` | `tokens_total tokens  chunks_used chunks` |
| 2.5.6 | `truncated: true` | yellow `truncated!` suffix on prompt line |
| 2.5.7 | `event: "generate"` | model name, duration, `tokens_in→tokens_out tokens` |
| 2.5.8 | `tokens_in: null` | token counts omitted |
| 2.5.9 | Unknown event value | `[source]  cyan(event)` — no crash, no missing field errors |

### 2.6 Separator Lines

| # | Test | Expected |
|---|------|----------|
| 2.6.1 | Service connects | `── React connected ──────────────────── 08:14:20` |
| 2.6.2 | Service disconnects | same format with `disconnected` |
| 2.6.3 | Source name very long | dashes truncate gracefully, line doesn't overflow |

### 2.7 Startup Banner

| # | Test | Expected |
|---|------|----------|
| 2.7.1 | Server starts, no config | banner shows `ws://localhost:4242  http://localhost:4242/logs` |
| 2.7.2 | Config has 2 services | banner row shows `Vite :5173  ·  FastAPI :3001` with source colors |
| 2.7.3 | Config has many services | all fit in one row or wrap cleanly |

---

## 3. HTTP API Endpoints

All tests: `curl http://localhost:4242/<endpoint>`

Populate the buffer first by running the test server and making a few requests.

### 3.1 `/logs`

| # | Test | Command | Expected |
|---|------|---------|----------|
| 3.1.1 | All logs | `GET /logs` | JSON array of recent log entries |
| 3.1.2 | Filter by source | `GET /logs?source=FastAPI` | only FastAPI entries |
| 3.1.3 | Filter by level | `GET /logs?level=error` | only `level:"error"` entries |
| 3.1.4 | Limit count | `GET /logs?n=5` | exactly 5 entries |
| 3.1.5 | Plain text | `GET /logs?format=text` | newline-separated, no ANSI codes |
| 3.1.6 | Empty buffer | `GET /logs` with no messages | `[]` |

### 3.2 `/errors`

| # | Test | Expected |
|---|------|----------|
| 3.2.1 | Mix of log levels | only `level:"error"` logs returned |
| 3.2.2 | Network 5xx | 500/503 network responses included |
| 3.2.3 | Network 4xx | 404s NOT included (client errors are not server errors) |
| 3.2.4 | No errors | `[]` |

### 3.3 `/network`

| # | Test | Expected |
|---|------|----------|
| 3.3.1 | All requests | JSON array of network entries |
| 3.3.2 | `?source=React` | only React network activity |
| 3.3.3 | `?status=404` | only 404 responses |
| 3.3.4 | `?format=text` | readable plain text |

### 3.4 `/summary`

| # | Test | Expected |
|---|------|----------|
| 3.4.1 | Basic | connected source count, total message count, error count |
| 3.4.2 | Zero state | all counts zero, no crash |

### 3.5 `/sources`

| # | Test | Expected |
|---|------|----------|
| 3.5.1 | Two connected services | array with `name`, `connected: true`, `lastSeen`, `logs`, `network`, `errors`, `messagesPerMin` |
| 3.5.2 | Service disconnected | `connected: false`, `lastSeen` still populated |
| 3.5.3 | No connections | `[]` |
| 3.5.4 | `messagesPerMin` accuracy | send 60 messages in 60s, check value is ~1 |

### 3.6 `/timeline`

| # | Test | Expected |
|---|------|----------|
| 3.6.1 | `?since=30s` | all events in last 30 seconds, chronological |
| 3.6.2 | `?since=2m` | last 2 minutes |
| 3.6.3 | `?since=1h` | last hour |
| 3.6.4 | `?since=<unix_ms>` | from exact timestamp |
| 3.6.5 | `?since=mark_<id>` | from a previously created mark |
| 3.6.6 | Invalid mark ID | `[]` or clear error, no crash |
| 3.6.7 | No `since` param | sensible default (e.g., last 5 min) |
| 3.6.8 | `?format=text` | plain text, one line per event |

### 3.7 `/search`

| # | Test | Expected |
|---|------|----------|
| 3.7.1 | Basic | `GET /search?q=userId` — matching messages from all sources |
| 3.7.2 | Source filter | `GET /search?q=error&source=FastAPI` |
| 3.7.3 | Type filter | `GET /search?q=401&type=network` |
| 3.7.4 | Case insensitive | `?q=ERROR` matches `error` |
| 3.7.5 | URL encoding | `?q=user+id` and `?q=user%20id` both work |
| 3.7.6 | Empty query | `?q=` returns all or a clear error |
| 3.7.7 | No matches | `[]` |

### 3.8 `/slow`

| # | Test | Expected |
|---|------|----------|
| 3.8.1 | Default threshold | `GET /slow` — requests over 500ms, sorted slowest-first |
| 3.8.2 | Custom threshold | `GET /slow?ms=200` — requests over 200ms |
| 3.8.3 | `?ms=0` | all network requests |
| 3.8.4 | Source filter | `GET /slow?source=FastAPI` |
| 3.8.5 | No slow requests | `[]` |

### 3.9 `/repeat`

| # | Test | Expected |
|---|------|----------|
| 3.9.1 | Repeated message | grouped with `count`, sorted by count descending |
| 3.9.2 | `?min=3` | only messages appearing 3+ times |
| 3.9.3 | `?since=1m` | time-scoped |
| 3.9.4 | All unique messages | `[]` |
| 3.9.5 | Near-duplicate messages | treated as separate (exact match only) — document this |

### 3.10 `/context`

| # | Test | Expected |
|---|------|----------|
| 3.10.1 | Basic | `GET /context?at=<ts>&window=10s` — all events ±10s around timestamp |
| 3.10.2 | Source filter | `&source=FastAPI` |
| 3.10.3 | No nearby events | `[]` |
| 3.10.4 | `window=0s` | only events at the exact millisecond |

### 3.11 `/trace`

| # | Test | Expected |
|---|------|----------|
| 3.11.1 | Basic | `GET /trace?url=/api/users` — frontend, backend, and interleaved logs |
| 3.11.2 | Method filter | `GET /trace?url=/api/items&method=POST` |
| 3.11.3 | URL not in buffer | `[]` |
| 3.11.4 | Partial trace | only frontend sent, backend never received — returns frontend half only |
| 3.11.5 | Multiple requests same URL | returns all matches as array |
| 3.11.6 | URL with query string | confirm whether it matches on path only or full URL, document behavior |

### 3.12 `POST /mark`

| # | Test | Expected |
|---|------|----------|
| 3.12.1 | Create mark | `POST /mark {"label":"test"}` → `{id, label, time}` |
| 3.12.2 | Timeline after mark | `GET /timeline?since=mark_<id>` returns only events after mark |
| 3.12.3 | Invalid JSON body | 400 response |
| 3.12.4 | Body missing `label` | still works with empty label, or returns clear error |
| 3.12.5 | Mark ID reuse | using the same mark ID twice returns consistent results |

### 3.13 `/rag`

| # | Test | Expected |
|---|------|----------|
| 3.13.1 | All RAG events | `GET /rag` — all retrieve/rerank/prompt/generate entries |
| 3.13.2 | Source filter | `GET /rag?source=MyRAGApp` |
| 3.13.3 | Time filter | `GET /rag?since=5m` |

### 3.14 `/rag/quality`

| # | Test | Expected |
|---|------|----------|
| 3.14.1 | Low score | query with `topScore < 0.7` — flagged as low confidence |
| 3.14.2 | Truncated context | `truncated: true` — flagged |
| 3.14.3 | Cut off generation | `finish_reason: "length"` — flagged |
| 3.14.4 | Slow end-to-end | total duration > 3000ms — flagged |
| 3.14.5 | All clean | empty issues list |

### 3.15 `/rag/slow`

| # | Test | Expected |
|---|------|----------|
| 3.15.1 | Default | RAG queries slower than threshold |
| 3.15.2 | `?ms=2000` | only queries over 2s |
| 3.15.3 | Broken down by step | shows which step (retrieve/generate) was slow |

### 3.16 `?format=text` (all endpoints)

| # | Test | Expected |
|---|------|----------|
| 3.16.1 | `/errors?format=text` | plain text, newline-separated |
| 3.16.2 | `/trace?format=text` | readable flat structure |
| 3.16.3 | No ANSI codes | grep for `\x1B` — must be absent |

---

## 4. Request Correlation

**Setup:** React frontend + Express backend, both connected to tablog.

| # | Test | Expected |
|---|------|----------|
| 4.1 | Basic match | `GET /api/users` from React, within 3s Express receives it → Express line shows `<> React` |
| 4.2 | Same URL, different method | `GET /api/users` and `POST /api/users` are NOT correlated with each other |
| 4.3 | 3s window expiry | Frontend sends, backend responds after 3.5s — no correlation |
| 4.4 | Two rapid requests, same URL | each request correlates with its own backend counterpart independently |
| 4.5 | Frontend sends, backend silent | no match, frontend line has no suffix, no crash |
| 4.6 | URL with query string | document whether `/api/users?page=2` matches `/api/users` or requires exact match |
| 4.7 | Correlation in split view | `<> React` suffix visible in compact network line format |
| 4.8 | Correlation in `/trace` response | matched pair returned as one trace object |

---

## 5. Split View

**Setup:** Two services connected. Type `/split 2` in tablog terminal.

| # | Test | Expected |
|---|------|----------|
| 5.1 | Enter split mode | two columns, header row with source names, each column shows only its source |
| 5.2 | `/split React FastAPI` | columns assigned by name |
| 5.3 | New log arrives | appears only in correct column |
| 5.4 | New network request | compact format (`200  GET  /url  45ms  1.2kB`) in correct column |
| 5.5 | Text wraps in column | stays within column width, no overflow into adjacent column |
| 5.6 | Arrow up/down | scrolls within focused column, other column unaffected |
| 5.7 | Tab key | switches focus between columns; focus indicator in header updates |
| 5.8 | Column at top of scroll | up arrow does nothing, no negative offset |
| 5.9 | Column has no scroll history | down arrow when already at bottom does nothing |
| 5.10 | Type command in split mode | characters appear in command input row at bottom |
| 5.11 | Enter command in split mode | command executes (e.g., `/export` works) |
| 5.12 | `/split off` | returns to normal streaming, panel cleared, terminal restored |
| 5.13 | Terminal resize during split | layout redraws with new dimensions, no crash |
| 5.14 | Very narrow terminal (< 60 cols) | graceful degradation, no garbled output |
| 5.15 | 3+ sources, `/split 2` | shows first two detected services |

---

## 6. Filter Menu (`/change`)

**Setup:** Multiple services connected.

| # | Test | Expected |
|---|------|----------|
| 6.1 | Open menu | sources listed with toggle state and message counts |
| 6.2 | Toggle source off | source hidden from stream |
| 6.3 | Toggle source back on | messages resume |
| 6.4 | Toggle network off | network lines stop appearing |
| 6.5 | Toggle logs off | log lines stop appearing |
| 6.6 | Messages arrive while menu open | queued; flush to terminal when menu closes |
| 6.7 | Toggle all sources off | stream goes silent |
| 6.8 | Source connects after menu last opened | appears in menu on next open |
| 6.9 | Only one source | menu shows it, toggling works |

---

## 7. Python Middleware

### 7.1 FastAPI / ASGI (`TablogMiddleware`)

```python
app = FastAPI()
app.add_middleware(TablogMiddleware)
```

| # | Test | Expected |
|---|------|----------|
| 7.1.1 | `GET /api/ping` → 200 | network message: method, URL, status, duration, requestSize, responseSize |
| 7.1.2 | `POST /api/items` with JSON body | `requestSize` reflects body byte count |
| 7.1.3 | Streaming response | `responseSize: 0` or `-1`, no hang |
| 7.1.4 | Handler raises exception → 500 | 500 captured in network message before re-raising |
| 7.1.5 | Request with no body | `requestSize: 0` |
| 7.1.6 | `/docs` and `/openapi.json` | captured unless explicitly excluded |

### 7.2 Flask (`TablogFlaskMiddleware`)

```python
app = Flask(__name__)
TablogFlaskMiddleware(app)
```

| # | Test | Expected |
|---|------|----------|
| 7.2.1 | `GET /` → 200 | network message sent |
| 7.2.2 | Redirect → 301 | 301 captured |
| 7.2.3 | Unhandled exception → 500 | captured |

---

## 8. RAG Middleware

### 8.1 LangChain (`TablogCallbackHandler`)

```python
from tablog.langchain import TablogCallbackHandler
handler = TablogCallbackHandler()
```

| # | Test | Expected |
|---|------|----------|
| 8.1.1 | Retrieval returns 3 docs | `event:"retrieve"`, `count:3`, `topScore` from `doc.metadata["score"]` |
| 8.1.2 | Docs with no `score` metadata | `topScore: null` — no crash |
| 8.1.3 | Retrieval duration | `duration_ms` is wall-clock time between `on_retriever_start` and `on_retriever_end` |
| 8.1.4 | LLM generates response | `event:"generate"` with `tokens_in`, `tokens_out` from `llm_output["token_usage"]` |
| 8.1.5 | LLM with no `token_usage` | `tokens_in: null` — no crash |
| 8.1.6 | LangChain not installed | `TablogCallbackHandler` is importable without error; is a plain `object` |
| 8.1.7 | Handler on chain, not just LLM | both retrieval and generation callbacks fire |
| 8.1.8 | `source` override | `TablogCallbackHandler(source="SearchBot")` — uses `SearchBot` in events |

### 8.2 LlamaIndex (`TablogEventHandler`)

```python
from tablog.llamaindex import tablog_dispatcher
dispatcher = tablog_dispatcher()
```

| # | Test | Expected |
|---|------|----------|
| 8.2.1 | `RetrievalEndEvent` fires | `event:"retrieve"` sent with doc count and scores |
| 8.2.2 | `LLMPredictEndEvent` fires | `event:"generate"` sent |
| 8.2.3 | LlamaIndex not installed | `TablogEventHandler` is importable, is a plain `object` |
| 8.2.4 | `tablog_dispatcher()` called twice | does not double-register; deduplicated |
| 8.2.5 | Unknown event class fires | `handle()` silently ignores — no crash, no error log |
| 8.2.6 | `source` override | `tablog_dispatcher(source="MyIndex")` — uses `MyIndex` in events |

---

## 9. Caller Location (`file` + `line`)

| # | Test | Expected |
|---|------|----------|
| 9.1 | Basic call | `tablog("msg")` on line 10 of `main.py` → `file:"main.py"`, `line:10` |
| 9.2 | Inside class method | correct file and line of the method call |
| 9.3 | Inside async function | correct file and line |
| 9.4 | Called from `__init__` | correct |
| 9.5 | Called from REPL | `file:"<stdin>"` — renders as-is, no crash |
| 9.6 | Called via `exec()` | `file:"<string>"` — renders as-is, no crash |
| 9.7 | Full path in `file` | only `basename` shown in terminal (`main.py` not `/home/user/app/main.py`) |
| 9.8 | Present in JSON export | `file` and `line` fields appear in `.json` export |
| 9.9 | JS log (no `file` field) | no suffix rendered, no `:undefined` |
| 9.10 | Wrapper pattern | document: `file`/`line` points to the wrapper function's call site, not the end caller |

---

## 10. Session Export

| # | Test | Expected |
|---|------|----------|
| 10.1 | `/export` command | creates `tablog-YYYYMMDD-HHMMSS.json` and `.log` |
| 10.2 | `.json` structure | array of `{time, type, source, message, ...}` objects |
| 10.3 | `.log` structure | human-readable, ANSI stripped, each line prefixed with `HH:MM:SS` |
| 10.4 | RAG messages | appear in export with all event fields |
| 10.5 | `file`/`line` fields | present in `.json` for Python log messages |
| 10.6 | Empty session | exports empty files without crash |
| 10.7 | Export path has spaces | no crash, files created correctly |
| 10.8 | Run `/export` twice | two separate files created with different timestamps |

---

## 11. Framework Auto-Detection

### JavaScript

| # | Test | Expected |
|---|------|----------|
| 11.1 | Running under Vite | `source: "Vite"` |
| 11.2 | Running under Next.js | `source: "Next.js"` |
| 11.3 | Running under Express | `source: "Express"` |
| 11.4 | No framework detected | `source: "Node"` or `"Unknown"` |
| 11.5 | `TABLOG_SOURCE=MyApp` set | overrides detection, uses `"MyApp"` |

### Python

| # | Test | Expected |
|---|------|----------|
| 11.6 | FastAPI in `sys.modules` | `source: "FastAPI"` |
| 11.7 | Flask in `sys.modules` | `source: "Flask"` |
| 11.8 | Neither | `source: "Python"` |
| 11.9 | `TABLOG_SOURCE=MyApp` set | uses `"MyApp"` |
| 11.10 | `init(source="Custom")` | uses `"Custom"` |

---

## 12. Setup Wizard

| # | Test | Expected |
|---|------|----------|
| 12.1 | First run, no config file | wizard prompts for port numbers |
| 12.2 | Press Enter to skip all prompts | defaults used, config saved |
| 12.3 | Vite running on 5173 | scan detects it, suggests `"Vite"` in banner |
| 12.4 | Port 3000 open | suggested as React or Next.js |
| 12.5 | Port 8080 open | correctly identified, not misidentified as Next.js |
| 12.6 | Vite on IPv6 only | detected via `::1` fallback |
| 12.7 | Config file exists on subsequent run | wizard skipped, config loaded silently |
| 12.8 | Config file is malformed JSON | graceful error message, wizard runs |
| 12.9 | No services running | wizard completes with empty services list |
| 12.10 | `alt-tab.config.json` has unknown fields | ignored, known fields used |

---

## 13. Connection & Resilience

| # | Test | Expected |
|---|------|----------|
| 13.1 | Python starts before server | messages queued, drain when server comes up |
| 13.2 | Server restarts mid-session | Python reconnects within ~2s, queued messages drain |
| 13.3 | Server port already in use | clear error on startup |
| 13.4 | Two Python services on same port | both connect, differentiated by `source` label |
| 13.5 | Malformed JSON sent to server | silently ignored, server stays up, other clients unaffected |
| 13.6 | WebSocket message > 1MB | handled without crash |
| 13.7 | Client sends non-JSON text | ignored |
| 13.8 | Client disconnects abruptly | `disconnected` separator shown, server continues |

---

## 14. Known Limitations to Document

These are not bugs — they are intentional trade-offs that should be clearly stated in the README.

| # | Limitation | Note |
|---|------------|------|
| 14.1 | `file`/`line` points to wrapper, not original caller | Expected when `tablog()` is wrapped in a helper function |
| 14.2 | Request correlation uses 3s time window | Backend responses after 3s will not be correlated |
| 14.3 | Correlation matches on method + URL path only | Query strings not considered |
| 14.4 | `/repeat` uses exact string match | Near-duplicates (e.g., different timestamps in message) are counted separately |
| 14.5 | `file`/`line` only available from Python | JS `tablog()` does not capture call site |
| 14.6 | Split view requires at least 2 connected sources | `/split 2` with one source shows one populated column |
| 14.7 | Session buffer is in-memory | Restarting the server clears all history; use `/export` to persist |

---

## Priority Order

Run in this order on a fresh environment:

1. Core flow: Python `tablog("msg")` → appears in terminal with `file:line`
2. JS flow: `tablog("msg")` from browser → appears in terminal
3. HTTP API: `curl localhost:4242/logs`, `/errors`, `/sources`, `/summary`
4. Request correlation: hit an API endpoint from the browser, verify `<> React` on backend line
5. `/trace`: `curl "localhost:4242/trace?url=/api/ping"`
6. Split view: `/split 2`, type logs, use arrow keys and Tab
7. RAG: run LangChain handler, verify `retrieve` and `generate` events appear
8. Export: `/export`, verify both output files
9. Edge cases: REPL caller location, server restart recovery, wrapper pattern behavior
