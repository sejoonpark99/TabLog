# Python API

## Installation

```bash
pip install tablog
```

With framework extras:

```bash
pip install tablog[fastapi]   # includes starlette
pip install tablog[flask]     # includes flask
```

---

## `tablog(*args)`

Drop-in replacement for `print()`. Accepts any number of arguments.

```python
from tablog import tablog

tablog('user logged in')
tablog('query result:', {'rows': 42})
tablog('multiple', 'args', 'joined', 'with spaces')
```

Objects are serialised with `json.dumps`. Strings are passed through as-is.

The client connects to the tablog WebSocket server in a background daemon thread. Messages are queued and flushed once the connection is established — if the server isn't running yet, messages buffer automatically and appear when it starts.

---

## `init(source=None, port=None)`

Explicitly initialise the client. Optional — `tablog()` lazy-inits on first call.

```python
from tablog import init

init(source='MyService', port=4242)
```

### Auto-detection

`source` is inferred from `sys.modules`:

| Module present | Source label |
|---------------|-------------|
| `fastapi` | `FastAPI` |
| `flask` | `Flask` |
| `django` | `Django` |
| `starlette` | `Starlette` |
| `aiohttp` | `aiohttp` |
| `tornado` | `Tornado` |
| *(none)* | `Python` |

Override with `TABLOG_SOURCE` env var or pass `source` explicitly.

---

## `TablogMiddleware` (FastAPI / Starlette)

ASGI middleware that captures every incoming HTTP request and response.

```python
from fastapi import FastAPI
from tablog.middleware import TablogMiddleware

app = FastAPI()
app.add_middleware(TablogMiddleware, source='FastAPI')
```

Logs appear as:

```
[FastAPI]  ↙  GET   /api/users   200   18ms   1.2kB
[FastAPI]  ↙  POST  /api/items   201   40ms   523B
```

Works with any ASGI framework: FastAPI, Starlette, Litestar, etc.

---

## `TablogFlaskMiddleware` (Flask)

WSGI middleware for Flask.

```python
from flask import Flask
from tablog.middleware import TablogFlaskMiddleware

app = Flask(__name__)
TablogFlaskMiddleware(app)

# or as an extension:
ext = TablogFlaskMiddleware()
ext.init_app(app)
```

---

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TABLOG_PORT` | `4242` | WebSocket server port |
| `TABLOG_SOURCE` | auto-detected | Override source label |

---

## Output format (when server unreachable)

If the tablog server is unreachable, `tablog()` and the middleware print to stdout as a fallback:

```
[FastAPI] user logged in
[FastAPI] ↙ GET /api/users  200  18ms
```
