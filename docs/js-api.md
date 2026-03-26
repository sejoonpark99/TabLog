# JavaScript / TypeScript API

## Installation

```bash
npm install tablog
# or
bun add tablog
```

---

## `tablog(...args)`

Drop-in replacement for `console.log`. Accepts any number of arguments — strings, objects, arrays, anything JSON-serialisable.

```ts
import { tablog } from 'tablog'

tablog('user logged in')
tablog('query result:', { rows: 42 })
tablog('error:', new Error('something failed'))
```

Objects are serialised with `JSON.stringify`. Falls back to `console.log` if the server is unreachable.

---

## `init(options?)`

Initialises the tablog client. Call once at your app's entry point. `tablog()` calls lazy-init automatically, but calling `init()` explicitly lets you set options.

```ts
import { init } from 'tablog'

init({
  source: 'React',    // label shown in the terminal — auto-detected if omitted
  port: 4242,         // tablog server port — defaults to TABLOG_PORT env var or 4242
  network: true,      // intercept fetch + XHR (browser only)
})
```

### `source`

Auto-detection checks the running framework:
- Browser: React · Angular · Vue · Next.js · Nuxt · Svelte
- Node.js: Express · Fastify · NestJS · Hono · Koa

Override with `TABLOG_SOURCE` env var or pass `source` explicitly.

### `network: true` (browser only)

Monkey-patches `window.fetch` and `XMLHttpRequest` to capture every outgoing request:

```
[React]  ↗  GET   /api/users   200   22ms   1.2kB
[React]  ↗  POST  /api/items   201   45ms   523B
```

---

## `expressMiddleware()`

Express-compatible middleware that captures every incoming HTTP request and response.

```ts
import express from 'express'
import { expressMiddleware } from 'tablog'

const app = express()
app.use(expressMiddleware())
```

Logs appear as:

```
[Express]  ↙  GET   /api/users   200   18ms   1.2kB
[Express]  ↙  POST  /api/items   201   40ms   523B
```

Works with any Express-compatible framework (Fastify with adapter, Koa with adapter, etc.).

---

## Browser (script tag / CDN)

```html
<script src="https://unpkg.com/tablog/dist/browser.global.js"></script>
<script>
  const { tablog, init } = Tablog
  init({ source: 'Browser', network: true })
  tablog('page loaded')
</script>
```

---

## TypeScript

Full type definitions are included. Key types:

```ts
interface TablogOptions {
  source?: string
  port?: number
  network?: boolean
}

function tablog(...args: unknown[]): void
function init(options?: TablogOptions): void
function expressMiddleware(): (req, res, next) => void
```
