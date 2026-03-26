import http from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import type { NetworkMessage } from './network'

export interface LogMessage {
  type?: 'log'
  source: string
  message: string
  level?: 'log' | 'warn' | 'error' | 'info'
  timestamp: number
  file?: string
  line?: number
}

export interface RagMessage {
  type: 'rag'
  event: 'retrieve' | 'rerank' | 'prompt' | 'generate'
  source: string
  timestamp: number
  query?: string
  duration_ms?: number
  count?: number
  topScore?: number | null
  results?: Array<{ id?: string; score?: number; text: string }>
  inputCount?: number
  outputCount?: number
  chunks_used?: number
  tokens_context?: number
  tokens_total?: number
  truncated?: boolean
  model?: string
  tokens_in?: number | null
  tokens_out?: number | null
  finish_reason?: string
}

export type AltTabMessage = LogMessage | NetworkMessage | RagMessage

export interface ServerOptions {
  port: number
  onMessage: (msg: AltTabMessage) => void
  onConnect?: (source: string) => void
  onDisconnect?: (source: string) => void
  onHttpRequest?: (req: IncomingMessage, res: ServerResponse) => void
}

export function createServer(options: ServerOptions): http.Server {
  const httpServer = http.createServer((req, res) => {
    if (options.onHttpRequest) {
      options.onHttpRequest(req, res)
    } else {
      res.writeHead(404)
      res.end()
    }
  })

  const wss = new WebSocketServer({ server: httpServer })

  wss.on('connection', (ws: WebSocket) => {
    let clientSource = 'Unknown'
    let announced = false

    ws.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString()) as AltTabMessage
        if ('source' in msg && msg.source) {
          clientSource = msg.source
          if (!announced) {
            announced = true
            options.onConnect?.(clientSource)
          }
        }
        options.onMessage(msg)
      } catch {
        // ignore malformed messages
      }
    })

    ws.on('close', () => {
      options.onDisconnect?.(clientSource)
    })

    ws.on('error', () => {
      // absorb per-socket errors — the server stays up
    })
  })

  httpServer.listen(options.port)
  return httpServer
}
