# CLI Reference

## Starting the server

```bash
npx tablog
# or after local install:
node dist/cli.js
```

### Options via environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TABLOG_PORT` | `4242` | WebSocket server port |
| `TABLOG_TIMESTAMPS` | off | Set to `1` to prefix every line with `HH:MM:SS` |

```bash
TABLOG_PORT=9000 TABLOG_TIMESTAMPS=1 npx tablog
```

---

## Setup wizard

On first run (or when `tablog.config.json` is missing), tablog scans common ports and identifies running services:

```
  tablog  detecting running services...

  scanning ...............
  [1]  :5173   Vite      frontend   pid 12345
  [2]  :8000   FastAPI   backend    pid 67890

  Frontend [1]:
  Backend  [2]:
```

- Type a number and press Enter to select, or press Enter to accept the default (shown in brackets).
- Config is saved to `tablog.config.json`. Delete it to re-run the wizard.
- Detection uses TCP probes + HTTP header inspection + Vite/Next.js endpoint fingerprinting.

---

## Runtime commands

Type these into the tablog terminal while it's running:

### `/tab [source]`

Switch to a focused view of one service, or back to all.

```
/tab 1        focus on first connected source
/tab 2        focus on second connected source
/tab React    focus by source name (case-insensitive)
/tab all      show all sources
/tab 0        same as /tab all
```

Typing `/tab` with an unrecognised argument lists available sources.

### `/change`

Opens an interactive filter menu. Use number keys to toggle individual sources, `n` to toggle network lines, `l` to toggle log lines. Press `q` or Enter to return.

```
  ┌─ filter ──────────────────────────────────────┐
  │  [1] ✓  React     12 logs   3 reqs            │
  │  [2] ✓  FastAPI    5 logs   3 reqs            │
  │                                               │
  │  [n] network on    [l] logs on                │
  │  [Enter / q]  back to stream                  │
  └───────────────────────────────────────────────┘
```

### `/export`

Saves the current session buffer to two files in the working directory:

- `tablog-YYYYMMDD-HHmmss.json` — structured JSON (timestamps, types, sources, all fields)
- `tablog-YYYYMMDD-HHmmss.log` — human-readable, ANSI stripped

---

## Log format

### Log lines

```
[Source]   message text
[Source]   ● error message        (level: error — red)
[Source]   warning text           (level: warn  — yellow)
[Source]   info text              (level: info  — dim)
```

### Network lines

```
[Source]  ↗  METHOD  /path                 STATUS  DURATION  SIZE
[Source]  ↙  METHOD  /path                 STATUS  DURATION  SIZE   ↔ SourceName
```

- `↗` = outgoing (from frontend)
- `↙` = incoming (to backend)
- `↔ SourceName` = correlated pair — this backend request was triggered by that frontend source
- Duration coloring: dim < 200ms · yellow 200–500ms · red > 500ms
- Status coloring: green 2xx · cyan 3xx · yellow 4xx · red 5xx/error

### Separators

```
── React connected ─────────────────────────────── 08:14:20
── React disconnected ──────────────────────────── 08:15:30
── viewing: FastAPI ────────────────────────────── 08:16:00
```
