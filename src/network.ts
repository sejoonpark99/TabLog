/**
 * Network monitoring — mirrors Chrome DevTools Network tab in the terminal.
 *
 * Browser:  intercepts window.fetch and XMLHttpRequest
 * Node.js:  provides createExpressMiddleware() for Express/Fastify/etc.
 */

export interface NetworkMessage {
  type: 'network'
  source: string
  method: string
  url: string
  status: number
  duration: number
  requestSize: number
  responseSize: number
  timestamp: number
  direction: 'outgoing' | 'incoming'
}

type SendFn = (msg: NetworkMessage) => void

// ── Browser: fetch interception ───────────────────────────────────────────

export function interceptFetch(source: string, send: SendFn): void {
  if (typeof globalThis.fetch === 'undefined') return

  const original = globalThis.fetch.bind(globalThis)

  globalThis.fetch = async function (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const start = Date.now()
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
        ? input.href
        : (input as Request).url

    let requestSize = 0
    if (init?.body) {
      if (typeof init.body === 'string') requestSize = init.body.length
      else if (init.body instanceof URLSearchParams) requestSize = init.body.toString().length
      else if (init.body instanceof ArrayBuffer) requestSize = init.body.byteLength
      else if (init.body instanceof Blob) requestSize = init.body.size
    }

    try {
      const response = await original(input, init)
      const duration = Date.now() - start
      const cl = response.headers.get('content-length')
      const responseSize = cl ? parseInt(cl, 10) : -1

      send({
        type: 'network',
        source,
        method,
        url,
        status: response.status,
        duration,
        requestSize,
        responseSize,
        timestamp: Date.now(),
        direction: 'outgoing',
      })

      return response
    } catch (err) {
      send({
        type: 'network',
        source,
        method,
        url,
        status: 0,
        duration: Date.now() - start,
        requestSize,
        responseSize: -1,
        timestamp: Date.now(),
        direction: 'outgoing',
      })
      throw err
    }
  }
}

// ── Browser: XHR interception ─────────────────────────────────────────────

declare global {
  interface XMLHttpRequest {
    _atMethod?: string
    _atUrl?: string
    _atStart?: number
    _atReqSize?: number
  }
}

export function interceptXHR(source: string, send: SendFn): void {
  if (typeof XMLHttpRequest === 'undefined') return

  const proto = XMLHttpRequest.prototype
  const origOpen = proto.open
  const origSend = proto.send

  proto.open = function (method: string, url: string | URL, ...rest: unknown[]) {
    this._atMethod = method
    this._atUrl = typeof url === 'string' ? url : url.toString()
    // @ts-expect-error — spread over overloaded signature
    return origOpen.call(this, method, url, ...rest)
  }

  proto.send = function (body?: Document | XMLHttpRequestBodyInit | null) {
    this._atStart = Date.now()
    this._atReqSize = body ? body.toString().length : 0

    this.addEventListener('loadend', () => {
      send({
        type: 'network',
        source,
        method: (this._atMethod ?? 'GET').toUpperCase(),
        url: this._atUrl ?? '',
        status: this.status,
        duration: this._atStart ? Date.now() - this._atStart : 0,
        requestSize: this._atReqSize ?? 0,
        responseSize: this.responseText ? this.responseText.length : -1,
        timestamp: Date.now(),
        direction: 'outgoing',
      })
    })

    return origSend.call(this, body)
  }
}

// ── Node.js: Express-compatible middleware ────────────────────────────────

export function createExpressMiddleware(source: string, send: SendFn) {
  return function tablogMiddleware(
    req: { method?: string; originalUrl?: string; url?: string; headers?: Record<string, string>; on: Function },
    res: { statusCode?: number; end: Function },
    next: () => void,
  ) {
    const start = Date.now()
    let requestSize = 0

    req.on('data', (chunk: Buffer) => {
      requestSize += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk))
    })

    const originalEnd = res.end.bind(res)

    res.end = function (chunk?: unknown, ...args: unknown[]) {
      let responseSize = 0
      if (chunk) {
        if (Buffer.isBuffer(chunk)) responseSize = chunk.length
        else if (typeof chunk === 'string') responseSize = Buffer.byteLength(chunk)
      }

      send({
        type: 'network',
        source,
        method: (req.method ?? 'GET').toUpperCase(),
        url: req.originalUrl ?? req.url ?? '/',
        status: res.statusCode ?? 200,
        duration: Date.now() - start,
        requestSize,
        responseSize,
        timestamp: Date.now(),
        direction: 'incoming',
      })

      return originalEnd(chunk, ...args)
    }

    next()
  }
}
