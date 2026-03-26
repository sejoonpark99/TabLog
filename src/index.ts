import { detectFramework } from './detector'
import { interceptFetch, interceptXHR, createExpressMiddleware } from './network'
import type { NetworkMessage } from './network'

const DEFAULT_PORT = 4242

export interface TablogOptions {
  /** Override auto-detected framework label, e.g. "MyService" */
  source?: string
  /** WebSocket port (default 4242, or TABLOG_PORT env var) */
  port?: number
  /**
   * Auto-intercept network requests.
   * Defaults to true in browser environments.
   * Set to false to disable.
   */
  network?: boolean
}

// ── Internal state ────────────────────────────────────────────────────────

let _ws: WebSocket | null = null
let _queue: string[] = []
let _source = ''
let _port = DEFAULT_PORT
let _connecting = false
let _initialized = false

function _resolvePort(): number {
  if (typeof process !== 'undefined' && process.env?.TABLOG_PORT) {
    return parseInt(process.env.TABLOG_PORT, 10)
  }
  return DEFAULT_PORT
}

function _getWebSocket(url: string): WebSocket | null {
  try {
    if (typeof WebSocket !== 'undefined') return new WebSocket(url)
    // Older Node.js — fall back to bundled ws package
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { WebSocket: WS } = require('ws')
    return new WS(url) as unknown as WebSocket
  } catch {
    return null
  }
}

function _connect(): void {
  if (_connecting || (_ws && _ws.readyState === WebSocket.OPEN)) return
  _connecting = true

  const ws = _getWebSocket(`ws://localhost:${_port}`)
  if (!ws) { _connecting = false; return }

  _ws = ws

  ws.onopen = () => {
    _connecting = false
    for (const payload of _queue) ws.send(payload)
    _queue = []
  }

  ws.onerror = () => { _connecting = false; _ws = null }
  ws.onclose = () => { _connecting = false; _ws = null }
}

function _send(data: object): void {
  const payload = JSON.stringify(data)
  if (_ws && _ws.readyState === WebSocket.OPEN) {
    _ws.send(payload)
  } else {
    _queue.push(payload)
    _connect()
  }
}

function _fallback(source: string, message: string): void {
  console.log(`[${source}] ${message}`)
}

function _callerLocation(): { file: string; line: number } | null {
  try {
    const stack = new Error().stack ?? ''
    // Walk frames until we're outside this file
    const frames = stack.split('\n').slice(1)
    for (const frame of frames) {
      if (frame.includes('/index.') || frame.includes('\\index.') ||
          frame.includes('tablogger') || frame.includes('node_modules')) continue
      // Parse "    at funcName (file:line:col)" or "    at file:line:col"
      const m = frame.match(/\((.+):(\d+):\d+\)$/) ?? frame.match(/at (.+):(\d+):\d+$/)
      if (!m) continue
      const file = m[1].split(/[\\/]/).pop() ?? m[1]
      return { file, line: parseInt(m[2], 10) }
    }
  } catch { /* ignore */ }
  return null
}

function _serialize(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === 'string') return a
      try { return JSON.stringify(a) } catch { return String(a) }
    })
    .join(' ')
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Initialize tablog. Called automatically on first tablog() call.
 * Pass options to override source label, port, or disable network interception.
 */
export function init(options: TablogOptions = {}): void {
  if (_initialized) return
  _initialized = true

  _source = options.source ?? detectFramework()
  _port = options.port ?? _resolvePort()

  _connect()

  const interceptNetwork =
    options.network !== false && typeof window !== 'undefined'

  if (interceptNetwork) {
    interceptFetch(_source, (msg: NetworkMessage) => _send(msg))
    interceptXHR(_source, (msg: NetworkMessage) => _send(msg))
  }
}

/**
 * Universal logging function — drop-in replacement for console.log.
 *
 *   tablog('hello world')
 *   tablog('user', { id: 1 })
 *   tablog(someObject)
 *
 * Sends the log to the tablog terminal server.
 * Falls back to console.log with [Source] prefix if the server is unreachable.
 */
export function tablog(...args: unknown[]): void {
  if (!_initialized) init()

  const message = _serialize(args)
  const caller = _callerLocation()
  const payload = {
    type: 'log' as const,
    source: _source,
    message,
    level: 'log' as const,
    timestamp: Date.now(),
    ...(caller ?? {}),
  }

  if (_ws && _ws.readyState === WebSocket.OPEN) {
    _ws.send(JSON.stringify(payload))
  } else {
    _queue.push(JSON.stringify(payload))
    _connect()
    _fallback(_source, message)
  }
}

/**
 * Returns an Express/Fastify/Koa-compatible middleware that captures
 * incoming HTTP requests and sends them to the tablog network monitor.
 *
 *   app.use(expressMiddleware())
 */
export function expressMiddleware() {
  if (!_initialized) init()
  return createExpressMiddleware(_source, (msg: NetworkMessage) => _send(msg))
}

export default tablog
