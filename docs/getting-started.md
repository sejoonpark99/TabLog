# Getting Started

## Prerequisites

- Node.js 18+ (for the CLI and JS client)
- Python 3.8+ (for the Python client, optional)

## Step 1 — Start your services

Start your frontend and backend as you normally would:

```bash
# Terminal 1 — frontend
npm run dev        # Vite, CRA, Next.js, etc.

# Terminal 2 — backend
uvicorn main:app --reload   # FastAPI
# or
node server.js              # Express
```

## Step 2 — Start tablog

```bash
# Terminal 3
npx tablog
```

tablog scans your local ports, identifies running services, and asks you to confirm:

```
  tablog  detecting running services...

  scanning ...............
  [1]  :5173   Vite      frontend   pid 12345
  [2]  :8000   FastAPI   backend    pid 67890

  Frontend [1]:
  Backend  [2]:
```

Press Enter to accept the defaults or type a number to choose.

## Step 3 — Add tablog() to your code

### JavaScript / TypeScript

```bash
npm install tablog
```

**React (entry point):**
```js
import { init } from 'tablog'
init({ source: 'React', network: true })
```

**Express:**
```js
import { tablog, expressMiddleware } from 'tablog'
app.use(expressMiddleware())
```

Then replace `console.log` calls with `tablog`:
```js
tablog('user clicked button')
tablog('response:', data)
```

### Python

```bash
pip install tablog
```

**FastAPI:**
```python
from tablog import tablog
from tablog.middleware import TablogMiddleware

app.add_middleware(TablogMiddleware, source='FastAPI')
```

Then replace `print` calls with `tablog`:
```python
tablog('request received')
tablog('query result:', result)
```

## Step 4 — Watch everything in one place

All logs from all services stream to the tablog terminal with colored source labels:

```
── React connected ─────────────────────────────── 08:14:20
── FastAPI connected ───────────────────────────── 08:14:21
[React]    button clicked
[React]    ↗  GET  /api/users   200   22ms   1.2kB
[FastAPI]  ↙  GET  /api/users   200   18ms   1.2kB   ↔ React
[FastAPI]  fetching users from db
[FastAPI]  returning 3 users
```

## Next steps

- [CLI reference](./cli.md) — all commands and environment variables
- [JavaScript API](./js-api.md) — `tablog()`, `init()`, middleware
- [Python API](./python-api.md) — `tablog()`, middleware
- [Architecture](./architecture.md) — how it works under the hood
