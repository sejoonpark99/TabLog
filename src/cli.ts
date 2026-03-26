import readline from 'node:readline'
import pc from 'picocolors'
import { createServer } from './server'
import { formatLog, formatNetwork, formatSeparator, formatBanner, formatFocusChange } from './formatter'
import { filterState, registerMessage, shouldShow, openFilterMenu } from './filter'
import { appendToBuffer, exportSession, bufferSize } from './export'
import { loadConfig, runSetupWizard } from './setup'
import type { AltTabMessage } from './server'
import type { NetworkMessage } from './network'

const PORT = parseInt(process.env.TABLOG_PORT ?? process.env.ALT_TAB_PORT ?? '4242', 10)
const TIMESTAMPS = process.env.TABLOG_TIMESTAMPS === '1'

// ── Output queue (paused during /change menu) ─────────────────────────────

let outputPaused = false
const outputQueue: string[] = []

function writeLine(line: string): void {
  if (outputPaused) {
    outputQueue.push(line)
  } else {
    process.stdout.write(line + '\n')
  }
}

function pauseOutput(): void {
  outputPaused = true
}

function resumeOutput(): void {
  outputPaused = false
  for (const line of outputQueue) {
    process.stdout.write(line + '\n')
  }
  outputQueue.length = 0
}

// ── Timestamp prefix ──────────────────────────────────────────────────────

function ts(): string {
  if (!TIMESTAMPS) return ''
  return pc.dim(new Date().toTimeString().slice(0, 8)) + '  '
}

// ── Request correlation (match frontend ↗ to backend ↙) ──────────────────

type CorrelKey = string  // "METHOD:/path"

interface PendingRequest {
  source: string
  time: number
}

const pendingOutgoing = new Map<CorrelKey, PendingRequest>()
const CORREL_TTL = 3000  // ms

function correlKey(method: string, url: string): CorrelKey {
  // Normalize to just the pathname so relative (/api/x) matches absolute (http://host/api/x)
  let path = url
  try { path = new URL(url).pathname } catch { /* already a path */ }
  return `${method.toUpperCase()}:${path}`
}

function handleCorrelation(n: NetworkMessage): string | undefined {
  const key = correlKey(n.method, n.url)

  if (n.direction === 'outgoing') {
    pendingOutgoing.set(key, { source: n.source, time: Date.now() })
    setTimeout(() => pendingOutgoing.delete(key), CORREL_TTL)
    return undefined
  }

  if (n.direction === 'incoming') {
    const pending = pendingOutgoing.get(key)
    if (pending && Date.now() - pending.time < CORREL_TTL) {
      pendingOutgoing.delete(key)
      return pending.source
    }
  }

  return undefined
}

// ── Message handler ───────────────────────────────────────────────────────

function onMessage(msg: AltTabMessage): void {
  registerMessage(msg)
  if (!shouldShow(msg)) return

  let line: string

  if ((msg as NetworkMessage).type === 'network') {
    const n = msg as NetworkMessage
    const matchedSource = handleCorrelation(n)
    line = ts() + formatNetwork(
      n.source, n.method, n.url, n.status,
      n.duration, n.responseSize, n.requestSize,
      n.direction, matchedSource,
    )
  } else {
    const l = msg as { source: string; message: string; level?: string }
    line = ts() + formatLog(l.source, l.message, l.level)
  }

  appendToBuffer(msg, line)
  writeLine(line)
}

// ── Export helper ─────────────────────────────────────────────────────────

function doExport(): void {
  if (bufferSize() === 0) {
    process.stdout.write(pc.dim('  Nothing to export yet.\n'))
    return
  }
  try {
    const { jsonPath, logPath, count } = exportSession('.')
    process.stdout.write(
      pc.green('  ✓') +
        pc.dim(` exported ${count} entries`) +
        '\n' +
        pc.dim(`    ${jsonPath}\n`) +
        pc.dim(`    ${logPath}\n`),
    )
  } catch (err) {
    process.stdout.write(pc.red(`  Export failed: ${(err as Error).message}\n`))
  }
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Load or create config via setup wizard
  let config = loadConfig()
  if (!config) {
    config = await runSetupWizard().catch(() => null)
  }

  // Start WebSocket server
  const wss = createServer({
    port: PORT,
    onMessage,
    onConnect: (source) => writeLine(formatSeparator(source, 'connected')),
    onDisconnect: (source) => writeLine(formatSeparator(source, 'disconnected')),
  })

  wss.on('listening', () => {
    console.log(formatBanner(PORT, config))
  })

  wss.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(pc.red(`\nPort ${PORT} is already in use.`))
      console.error(pc.dim('Set TABLOG_PORT to use a different port and retry.'))
      process.exit(1)
    }
    throw err
  })

  // Set up stdin readline for /change and /export commands
  if (process.stdin.isTTY) {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
    })

    rl.on('line', (line: string) => {
      const cmd = line.trim()
      const cmdLower = cmd.toLowerCase()
      if (cmdLower === '/change') {
        openFilterMenu(rl, pauseOutput, resumeOutput)
      } else if (cmdLower === '/export') {
        doExport()
      } else if (cmdLower.startsWith('/tab')) {
        const arg = cmd.slice(4).trim()
        const sources = Array.from(filterState.knownSources.keys())

        if (!arg || arg === '0' || arg.toLowerCase() === 'all') {
          filterState.focusedSource = null
        } else {
          const n = parseInt(arg, 10)
          const target = !isNaN(n) ? sources[n - 1] : sources.find((s) => s.toLowerCase() === arg.toLowerCase())
          if (!target) {
            const list = sources.length
              ? sources.map((s, i) => `  ${pc.dim(`[${i + 1}]`)}  ${s}`).join('\n')
              : pc.dim('  no sources connected yet')
            process.stdout.write(`${list}\n`)
            return
          }
          filterState.focusedSource = target
        }
        writeLine(formatFocusChange(filterState.focusedSource))
      }
    })

    rl.on('close', () => process.exit(0))
  }

  process.on('SIGINT', () => {
    process.stdout.write('\n' + pc.dim('tablog shutting down…') + '\n')
    wss.close()
    process.exit(0)
  })
}

main().catch((err) => {
  console.error(pc.red('tablog failed to start:'), err)
  process.exit(1)
})
