# LLM Debugging API — Plan

tablog already collects every log and network request from every service into one
in-memory buffer, correlated and timestamped. This plan exposes that data as a
queryable HTTP API designed specifically for LLM debugging sessions.

Claude Code (or any LLM) can call these endpoints with its Bash tool — no MCP,
no file, no special integration. Just `curl localhost:4242/...`.

---

## What already exists

| Endpoint | Description |
|---|---|
| `GET /logs` | Recent log entries, filterable by source / level / type |
| `GET /errors` | Error-level logs + 5xx network responses |
| `GET /network` | Network requests, filterable by source / status |
| `GET /summary` | Connected sources, total message count, error count |

---

## Planned endpoints

### `GET /trace`

**The most powerful endpoint.** Takes a URL path and reconstructs the full
request chain across services: frontend outgoing → backend incoming → all logs
that fired in between (correlated by time window).

```
GET /trace?url=/api/users
GET /trace?url=/api/items&method=POST
```

Response (one object per matched chain):
```json
[
  {
    "url": "/api/users",
    "method": "GET",
    "duration_ms": 34,
    "frontend": {
      "source": "React",
      "time": 1711480001000,
      "status": 200,
      "responseSize": 128
    },
    "backend": {
      "source": "FastAPI",
      "time": 1711480001004,
      "status": 200,
      "duration_ms": 15
    },
    "logs": [
      { "source": "FastAPI", "message": "fetching users from db", "time": 1711480001005 },
      { "source": "FastAPI", "message": "returning 3 users",      "time": 1711480001020 }
    ]
  }
]
```

**Why it matters:** eliminates the need for distributed tracing infrastructure.
The correlation data already exists in the CLI — this just exposes it as a query.
One call tells the complete story of any request.

---

### `GET /search`

Full-text search across all log messages from all sources.

```
GET /search?q=userId
GET /search?q=ValueError&source=FastAPI
GET /search?q=401&type=network
```

Response: matching entries in chronological order, with source and timestamp.

**Why it matters:** trace a specific value (user ID, order ID, error text) as it
flows through multiple services. The thing you'd normally grep multiple terminal
windows for.

---

### `GET /timeline`

All events from all sources in strict chronological order, filtered by recency.

```
GET /timeline?since=30s
GET /timeline?since=2m
GET /timeline?since=<unix_timestamp>
```

Supports `since` as a duration (`30s`, `2m`, `1h`) or a Unix timestamp in ms.

Response: flat chronological list — logs and network requests interleaved,
same as the tablog terminal but queryable.

**Why it matters:** answers "what was the app doing right before it broke."
The first thing any debugger looks for.

---

### `GET /slow`

All network requests slower than a threshold. Default 500ms.

```
GET /slow
GET /slow?ms=200
GET /slow?ms=1000&source=FastAPI
```

Response: matching network entries sorted slowest-first, including source,
method, URL, duration, status.

**Why it matters:** Claude Code immediately knows where the performance
issues are without reading through everything. Often the first clue that
a bug is actually a timeout or a cascade.

---

### `GET /repeat`

Groups identical or similar log messages by frequency. Surfaces loops,
retry storms, and recurring errors that are invisible in a stream but
obvious when counted.

```
GET /repeat
GET /repeat?source=React&min=3
GET /repeat?since=1m
```

Response: deduplicated messages sorted by count descending.
```json
[
  { "message": "fetching users from db", "count": 47, "source": "FastAPI", "lastSeen": 1711480100 },
  { "message": "401 GET /api/auth",      "count": 12, "source": "React",   "lastSeen": 1711480099 }
]
```

**Why it matters:** a `fetching users from db` appearing 47 times in 10 seconds
is a bug. Invisible in the stream, obvious as a count.

---

### `GET /sources`

Health check for all connected services — are they actually running and sending
data?

```
GET /sources
```

Response:
```json
[
  {
    "name": "React",
    "connected": true,
    "lastSeen": 1711480100000,
    "logs": 142,
    "network": 38,
    "errors": 2,
    "messagesPerMin": 12
  },
  {
    "name": "FastAPI",
    "connected": true,
    "lastSeen": 1711480100000,
    "logs": 89,
    "network": 38,
    "errors": 0,
    "messagesPerMin": 8
  }
]
```

**Why it matters:** Claude Code can verify the environment is healthy before
debugging logic. If FastAPI isn't in this list, the problem is the connection,
not the code.

---

### `GET /context`

Zoom into a window of time around a specific timestamp. Useful when Claude Code
finds an error and wants to see what was happening ±N seconds around it.

```
GET /context?at=1711480001000&window=10s
GET /context?at=1711480001000&window=30s&source=FastAPI
```

Response: all events in the time window, chronological order.

**Why it matters:** errors don't happen in isolation. This is how you find the
cause that happened 3 seconds before the 500.

---

### `POST /mark`

Claude Code writes a named marker into the live log stream. Then it can query
`/timeline?since=<marker>` to see exactly what happened after a specific action.

```
POST /mark
{ "label": "about to trigger failing request" }
```

Response:
```json
{ "id": "mark_1711480001000", "label": "about to trigger failing request", "time": 1711480001000 }
```

Then:
```
GET /timeline?since=mark_1711480001000
```

**Why it matters:** gives Claude Code a clean before/after split. It marks a
point in time, triggers a reproduction, then reads only what happened after the
mark. No noise from earlier in the session.

---

## Response format

All endpoints return JSON by default. Add `?format=text` for plain text output —
more token-efficient for LLM consumption, readable like a log file.

```
GET /errors?format=text

08:14:22  [FastAPI]  error endpoint triggered — raising 500
08:14:22  [FastAPI]  500  GET  /api/error   0ms   35B
08:14:23  [React]    500  GET  /api/error  10ms   35B
```

---

## Typical Claude Code debugging session

```bash
# 1. Orient — what's connected, any obvious errors?
curl localhost:4242/summary
curl localhost:4242/sources

# 2. See what's broken
curl localhost:4242/errors

# 3. Trace the failing request end-to-end
curl localhost:4242/trace?url=/api/items&method=POST

# 4. Search for related context
curl "localhost:4242/search?q=creating item"

# 5. Mark a point, reproduce, check what happened
curl -X POST localhost:4242/mark -d '{"label":"reproducing POST /api/items"}'
# ... trigger the request ...
curl "localhost:4242/timeline?since=mark_<id>"

# 6. Check for loops or retry storms
curl localhost:4242/repeat

# 7. Check for slow requests
curl localhost:4242/slow?ms=200
```

---

## Implementation order

1. `/sources` — small, uses existing filterState data
2. `/search` — simple filter over sessionBuffer
3. `/timeline` — time-based filter, parse duration strings
4. `/slow` — filter network entries by duration
5. `/repeat` — group + count, requires message similarity logic
6. `/context` — time window query
7. `/trace` — most complex, builds on existing correlation logic
8. `/mark` + `?format=text` — finish with polish
