import readline from 'node:readline'
import { execSync } from 'node:child_process'
import pc from 'picocolors'
import { createServer } from './server'
import { formatLog, formatNetwork, formatSeparator, formatBanner, formatFocusChange } from './formatter'
import { filterState, registerMessage, shouldShow, openFilterMenu } from './filter'
import { appendToBuffer, exportSession, bufferSize, getRecentBuffer } from './export'
import { loadConfig, runSetupWizard } from './setup'
import type { AltTabMessage } from './server'
import type { NetworkMessage } from './network'

const PORT = parseInt(process.env.TABLOG_PORT ?? process.env.ALT_TAB_PORT ?? '4242', 10)
const TIMESTAMPS = process.env.TABLOG_TIMESTAMPS === '1'

// ── Output queue (paused during /change menu) ─────────────────────────────

let outputPaused = false
const outputQueue: Array<{ line: string; source?: string }> = []

// ── Split-column view ──────────────────────────────────────────────────────

const SPLIT_LINES = 22
const columnBuffers = new Map<string, string[]>()
let splitInitialized = false

function stripAnsiLocal(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1B\[[0-9;]*m/g, '')
}

function padVisual(s: string, width: number): string {
  const vis = stripAnsiLocal(s)
  if (vis.length > width) return vis.slice(0, width)
  return s + ' '.repeat(width - vis.length)
}

function renderSplitView(): void {
  const sources = filterState.splitSources!
  const numCols = sources.length
  const termWidth = process.stdout.columns || 120
  const colWidth = Math.floor((termWidth - (numCols - 1)) / numCols)
  const totalLines = SPLIT_LINES + 1  // header + content

  if (splitInitialized) {
    process.stdout.write(`\x1B[${totalLines}A\x1B[0J`)
  } else {
    process.stdout.write('\n'.repeat(totalLines))
    process.stdout.write(`\x1B[${totalLines}A\x1B[0J`)
    splitInitialized = true
  }

  // Header
  const headerCells = sources.map((s) => {
    const title = `- ${s} `
    const dashes = '-'.repeat(Math.max(0, colWidth - title.length))
    return pc.dim(title + dashes)
  })
  process.stdout.write(headerCells.join(pc.dim('+')) + '\n')

  // Content rows
  for (let row = 0; row < SPLIT_LINES; row++) {
    const cells = sources.map((s) => {
      const buf = columnBuffers.get(s) ?? []
      const lineIdx = buf.length - SPLIT_LINES + row
      const line = lineIdx >= 0 ? (buf[lineIdx] ?? '') : ''
      return padVisual(line, colWidth)
    })
    process.stdout.write(cells.join(pc.dim('|')) + '\n')
  }
}

function writeLineSplit(source: string, line: string): void {
  if (!columnBuffers.has(source)) columnBuffers.set(source, [])
  const buf = columnBuffers.get(source)!
  buf.push(stripAnsiLocal(line))
  if (buf.length > SPLIT_LINES * 3) buf.splice(0, buf.length - SPLIT_LINES)
  renderSplitView()
}

function writeLine(line: string, source?: string): void {
  if (outputPaused) {
    outputQueue.push({ line, source })
    return
  }
  if (filterState.splitSources && source && filterState.splitSources.includes(source)) {
    writeLineSplit(source, line)
    return
  }
  process.stdout.write(line + '\n')
}

function pauseOutput(): void {
  outputPaused = true
}

function resumeOutput(): void {
  outputPaused = false
  for (const { line, source } of outputQueue) {
    if (filterState.splitSources && source && filterState.splitSources.includes(source)) {
      writeLineSplit(source, line)
    } else {
      process.stdout.write(line + '\n')
    }
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
  writeLine(line, msg.source)
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

// ── Copy to clipboard ─────────────────────────────────────────────────────

function copyToClipboard(text: string): boolean {
  try {
    if (process.platform === 'win32') {
      execSync('clip', { input: text, stdio: ['pipe', 'ignore', 'ignore'] })
    } else if (process.platform === 'darwin') {
      execSync('pbcopy', { input: text, stdio: ['pipe', 'ignore', 'ignore'] })
    } else {
      execSync('xclip -selection clipboard', { input: text, stdio: ['pipe', 'ignore', 'ignore'] })
    }
    return true
  } catch {
    return false
  }
}

function doCopy(rl: readline.Interface): void {
  if (!process.stdin.isTTY) {
    process.stdout.write(pc.dim('  /copy requires an interactive terminal\n'))
    return
  }

  const entries = getRecentBuffer(30)
  if (entries.length === 0) {
    process.stdout.write(pc.dim('  Nothing to copy yet.\n'))
    return
  }

  const stripAnsi = (s: string) => s.replace(/\x1B\[[0-9;]*m/g, '')
  const selected = new Set<number>()
  let digitBuf = ''
  let digitTimer: ReturnType<typeof setTimeout> | null = null

  const W = 70

  function renderCopyMenu(): string[] {
    const lines: string[] = [
      '',
      pc.dim(`  ┌─ copy ${'─'.repeat(W - 7)}┐`),
    ]
    entries.forEach((e, i) => {
      const check = selected.has(i) ? pc.cyan('✓') : pc.dim('·')
      const num = pc.dim(`[${String(i + 1).padStart(2)}]`)
      const text = stripAnsi(e.rendered).slice(0, W - 10)
      lines.push(`  │ ${num} ${check}  ${text}`)
    })
    lines.push(`  │`)
    lines.push(`  │  ${pc.dim('[num]')} toggle  ${pc.dim('[a]')} all  ${pc.dim('[Enter/c]')} copy  ${pc.dim('[q]')} cancel`)
    lines.push(`  ${pc.dim('└' + '─'.repeat(W + 2) + '┘')}`)
    lines.push('')
    return lines
  }

  rl.pause()
  pauseOutput()

  let currentLines = renderCopyMenu()
  function draw() { process.stdout.write(currentLines.join('\n') + '\n') }
  function clearDraw() {
    for (let i = 0; i < currentLines.length; i++) process.stdout.write('\x1B[1A\x1B[2K')
    currentLines = renderCopyMenu()
    draw()
  }

  draw()
  process.stdin.setRawMode(true)
  process.stdin.resume()

  function commitDigits() {
    if (!digitBuf) return
    const idx = parseInt(digitBuf, 10) - 1
    digitBuf = ''
    digitTimer = null
    if (idx >= 0 && idx < entries.length) {
      if (selected.has(idx)) selected.delete(idx); else selected.add(idx)
      clearDraw()
    }
  }

  function onKey(raw: Buffer | string): void {
    // Always work with a plain string regardless of what stdin emits
    const key = Buffer.isBuffer(raw) ? raw.toString('utf8') : raw

    if (key === '\u0003') { cleanup(); process.exit(0) }

    if (key === '\r' || key === '\n' || key === 'c' || key === 'C') {
      if (digitTimer) { clearTimeout(digitTimer); commitDigits() }
      cleanup()
      const rows = selected.size > 0
        ? [...selected].sort((a, b) => a - b).map((i) => stripAnsi(entries[i].rendered))
        : entries.map((e) => stripAnsi(e.rendered))
      const ok = copyToClipboard(rows.join('\n'))
      writeLine(pc.dim(`  ${ok ? pc.green('✓') + ' copied' : '✗ clipboard unavailable'} (${rows.length} line${rows.length !== 1 ? 's' : ''})`))
      return
    }

    if (key === 'q' || key === 'Q') {
      if (digitTimer) { clearTimeout(digitTimer); digitBuf = '' }
      cleanup(); return
    }

    if (key === 'a' || key === 'A') {
      if (digitTimer) { clearTimeout(digitTimer); digitBuf = '' }
      if (selected.size === entries.length) selected.clear()
      else entries.forEach((_, i) => selected.add(i))
      clearDraw(); return
    }

    if (/^\d$/.test(key)) {
      digitBuf += key
      if (digitTimer) clearTimeout(digitTimer)
      // Commit immediately if we can't possibly get a longer valid number
      const maxNum = entries.length
      const soFar = parseInt(digitBuf, 10)
      if (soFar * 10 > maxNum) {
        commitDigits()
      } else {
        digitTimer = setTimeout(commitDigits, 400)
      }
    }
  }

  function cleanup() {
    if (digitTimer) { clearTimeout(digitTimer); digitBuf = '' }
    process.stdin.removeListener('data', onKey)
    if (process.stdin.isTTY) process.stdin.setRawMode(false)
    rl.resume()
    resumeOutput()
  }

  process.stdin.on('data', onKey)
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
      } else if (cmdLower === '/copy') {
        doCopy(rl)
      } else if (cmdLower.startsWith('/split')) {
        const arg = cmd.slice(6).trim()
        const argLower = arg.toLowerCase()
        if (!arg || argLower === 'off' || argLower === '0') {
          if (argLower === 'off' || argLower === '0') {
            filterState.splitSources = null
            splitInitialized = false
            columnBuffers.clear()
            writeLine(formatFocusChange(null))
          } else {
            // /split with no args — split all known sources
            const sources = Array.from(filterState.knownSources.keys())
            if (sources.length < 2) {
              process.stdout.write(pc.dim('  /split needs at least 2 connected sources\n'))
            } else {
              filterState.splitSources = sources.slice(0, 3)  // max 3 columns
              splitInitialized = false
              columnBuffers.clear()
            }
          }
        } else {
          const sources = Array.from(filterState.knownSources.keys())
          const selected = arg.split(/[\s,]+/).map((a) => {
            const n = parseInt(a, 10)
            return !isNaN(n)
              ? sources[n - 1]
              : sources.find((s) => s.toLowerCase() === a.toLowerCase())
          }).filter((s): s is string => !!s)
          if (selected.length < 2) {
            const list = sources.length
              ? sources.map((s, i) => `  ${pc.dim(`[${i + 1}]`)}  ${s}`).join('\n')
              : pc.dim('  no sources connected yet')
            process.stdout.write(`${list}\n`)
          } else {
            filterState.splitSources = selected.slice(0, 3)
            splitInitialized = false
            columnBuffers.clear()
          }
        }
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
