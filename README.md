# tablog

One function. Every language. One terminal.

`tablog()` is a drop-in replacement for `console.log` / `print()` that routes all logs — frontend, backend, any framework — to a single unified terminal. Run `npx tablog` once and see everything in one place with colored source labels, network request tracking, and live filtering.

```
npx tablog
```

```
[React]    button clicked (×3)
[React]    ↗  GET  /api/users              200    22ms   1.2kB
[FastAPI]  ↙  GET  /api/users              200    18ms   1.2kB   ↔ React
[FastAPI]  fetching users from db
[FastAPI]  returning 3 users
```

---

## Installation

### JavaScript / TypeScript

```bash
npm install tablog
# or
bun add tablog
```

### Python

```bash
pip install tablog
```

---

## Usage

### JavaScript / TypeScript

```js
import { tablog } from 'tablog'

tablog('user logged in')
tablog('query result:', { rows: 42 })
```

#### React / browser

```js
import { tablog, init } from 'tablog'

// Call once at app entry point
init({ source: 'React', network: true })

tablog('component mounted')
```

`network: true` intercepts all `fetch` and `XHR` calls and streams them to the terminal — no browser DevTools needed.

#### Express / Node.js backend

```js
import { tablog, expressMiddleware } from 'tablog'

app.use(expressMiddleware())  // captures all incoming requests

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

#### FastAPI / Starlette

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

---

## CLI

Start the log server:

```bash
npx tablog
```

On first run, tablog scans your local ports, identifies running services (Vite, FastAPI, Express, etc.), shows their PIDs, and asks you to confirm which is your frontend and backend. The config is saved to `tablog.config.json`.

```
  tablog  detecting running services...

  scanning ...............
  [1]  :5173   Vite      frontend   pid 12345
  [2]  :8000   FastAPI   backend    pid 67890

  Frontend [1]: 1
  Backend  [2]: 2

  Saved to tablog.config.json
```

### Commands (while tablog is running)

| Command | Description |
|---------|-------------|
| `/tab 1` | Focus on service 1 only |
| `/tab 2` | Focus on service 2 only |
| `/tab all` | Show all sources |
| `/change` | Open interactive filter menu |
| `/export` | Save session to `.json` + `.log` files |

---

## How it works

```
┌─────────────┐     tablog()      ┌──────────────────┐
│  React app  │ ────────────────► │                  │
│  (browser)  │   WebSocket       │  tablog terminal │
└─────────────┘                   │  ws://localhost  │
                                  │  :4242           │
┌─────────────┐     tablog()      │                  │
│  FastAPI    │ ────────────────► │  [React]  click  │
│  (Python)   │   WebSocket       │  [FastAPI] query │
└─────────────┘                   └──────────────────┘
```

- `npx tablog` starts a WebSocket server on port 4242 (configurable via `TABLOG_PORT`)
- Every `tablog()` call sends a JSON message to that server
- The CLI renders all messages with colored `[Source]` labels
- Network middleware (JS and Python) captures HTTP request/response metadata
- Frontend `↗` requests are automatically correlated with backend `↙` responses

---

## Configuration

`tablog.config.json` (auto-generated, gitignored):

```json
{
  "services": [
    { "name": "Vite",    "port": 5173, "role": "frontend", "pid": 12345 },
    { "name": "FastAPI", "port": 8000, "role": "backend",  "pid": 67890 }
  ]
}
```

Delete this file and re-run `npx tablog` to re-detect services.

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TABLOG_PORT` | `4242` | WebSocket server port |
| `TABLOG_SOURCE` | auto-detected | Override source label |
| `TABLOG_TIMESTAMPS` | off | Set to `1` to show timestamps |

---

## Request correlation

When a React app calls `fetch('/api/users')` and FastAPI handles it, tablog links the two log lines automatically:

```
[React]    ↗  GET  /api/users   200   22ms   1.2kB
[FastAPI]  ↙  GET  /api/users   200   18ms   1.2kB   ↔ React
```

Correlation works by matching `METHOD + path` within a 3-second window — no headers injected, no CORS issues.

---

## Python package

The Python client connects to the tablog server in a background daemon thread. If the server isn't running yet, messages queue up and flush automatically once it starts.

```
python/
├── tablog/
│   ├── __init__.py      # tablog() function + WebSocket client
│   ├── detector.py      # auto-detects FastAPI / Flask / Django
│   └── middleware.py    # ASGI (FastAPI) + WSGI (Flask) middleware
└── pyproject.toml
```

---

## License

MIT
