import readline from 'node:readline'
import { execSync } from 'node:child_process'
import pc from 'picocolors'
import { createServer } from './server'
import { formatLog, formatNetwork, formatNetworkCompact, formatSeparator, formatBanner, formatFocusChange, formatRag } from './formatter'
import { filterState, registerMessage, shouldShow, openFilterMenu } from './filter'
import { appendToBuffer, exportSession, bufferSize, getRecentBuffer, getAllBuffer } from './export'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { loadConfig, runSetupWizard } from './setup'
import type { AltTabMessage, RagMessage } from './server'
import type { NetworkMessage } from './network'

const PORT = parseInt(process.env.TABLOG_PORT ?? process.env.ALT_TAB_PORT ?? '4242', 10)
const TIMESTAMPS = process.env.TABLOG_TIMESTAMPS === '1'

// ── Output queue (paused during /change menu) ─────────────────────────────

let outputPaused = false
const outputQueue: Array<{ line: string; msg?: AltTabMessage }> = []

// ── Split-column view ──────────────────────────────────────────────────────

const SPLIT_LINES = 20
const columnBuffers = new Map<string, string[]>()
let splitInitialized = false
let focusedCol = 0
const scrollOffset = new Map<string, number>()
let splitCmdBuf = ''
let currentRl: readline.Interface | null = null

function stripAnsiLocal(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1B\[[0-9;]*m/g, '')
}

/** Truncate an ANSI-colored string to maxWidth visible characters. */
function truncateAnsi(s: string, maxWidth: number): string {
  let visible = 0
  let i = 0
  let result = ''
  while (i < s.length) {
    if (s[i] === '\x1B') {
      const start = i++
      while (i < s.length && s[i] !== 'm') i++
      i++
      result += s.slice(start, i)
    } else {
      if (visible >= maxWidth) break
      result += s[i++]
      visible++
    }
  }
  return result + '\x1B[0m'
}

function padVisual(s: string, width: number): string {
  const vis = stripAnsiLocal(s)
  if (vis.length > width) return truncateAnsi(s, width)
  return s + ' '.repeat(width - vis.length)
}

/** Break a colored line into rows that fit within colWidth. First row keeps ANSI colors. */
function wrapEntry(line: string, colWidth: number): string[] {
  const vis = stripAnsiLocal(line)
  if (vis.length <= colWidth) return [line]
  const rows: string[] = [truncateAnsi(line, colWidth)]
  const indent = '  '
  let remaining = vis.slice(colWidth)
  const w = Math.max(1, colWidth - indent.length)
  while (remaining.length > 0) {
    rows.push(indent + remaining.slice(0, w))
    remaining = remaining.slice(w)
  }
  return rows
}

function getSplitGeometry() {
  const termWidth = process.stdout.columns || 120
  const termHeight = process.stdout.rows || 24
  const contentLines = Math.min(SPLIT_LINES, Math.max(4, termHeight - 6))
  const totalLines = contentLines + 2  // header + content + command row
  const splitStartRow = termHeight - totalLines + 1  // 1-indexed
  const scrollRegionEnd = splitStartRow - 1
  return { termWidth, termHeight, contentLines, totalLines, splitStartRow, scrollRegionEnd }
}

function renderSplitView(): void {
  if (!filterState.splitSources) return
  const sources = filterState.splitSources
  const numCols = sources.length
  const { termWidth, contentLines, splitStartRow } = getSplitGeometry()
  const colWidth = Math.floor((termWidth - (numCols - 1)) / numCols)

  // Save cursor → jump to split panel start
  process.stdout.write('\x1B[s')
  process.stdout.write(`\x1B[${splitStartRow};1H`)

  // Header row — focused column shown in cyan bold, scroll offset shown if > 0
  const headerCells = sources.map((s, i) => {
    const isFocused = i === focusedCol
    const offset = scrollOffset.get(s) ?? 0
    const scrollStr = offset > 0 ? ` [+${offset}]` : ''
    const marker = isFocused ? '> ' : '- '
    const title = `${marker}${s}${scrollStr} `
    const dashes = '-'.repeat(Math.max(0, colWidth - title.length))
    return isFocused ? pc.bold(pc.cyan(title + dashes)) : pc.dim(title + dashes)
  })
  process.stdout.write('\x1B[2K' + headerCells.join(pc.dim('+')) + '\n')

  // Flatten buffer entries into display rows (with wrapping), applying scroll offset
  const flatRows = new Map<string, string[]>()
  for (const s of sources) {
    const buf = columnBuffers.get(s) ?? []
    const allRows: string[] = []
    for (const entry of buf) allRows.push(...wrapEntry(entry, colWidth))
    const offset = scrollOffset.get(s) ?? 0
    const endIdx = Math.max(0, allRows.length - offset)
    const startIdx = Math.max(0, endIdx - contentLines)
    const visibleRows = allRows.slice(startIdx, endIdx)
    while (visibleRows.length < contentLines) visibleRows.unshift('')
    flatRows.set(s, visibleRows)
  }

  // Content rows
  for (let row = 0; row < contentLines; row++) {
    const cells = sources.map((s) => {
      const rows = flatRows.get(s) ?? []
      return padVisual(rows[row] ?? '', colWidth)
    })
    process.stdout.write('\x1B[2K' + cells.join(pc.dim('|')) + '\n')
  }

  // Command input row
  const cmdLine = splitCmdBuf
    ? pc.dim('> ') + splitCmdBuf + pc.dim('_')
    : pc.dim('> arrows scroll/focus  tab switch col  /split off to exit')
  process.stdout.write('\x1B[2K' + cmdLine + '\n')

  // Restore cursor (back into the streaming scroll region)
  process.stdout.write('\x1B[u')
}

function scrollFocused(delta: number): void {
  if (!filterState.splitSources) return
  const source = filterState.splitSources[focusedCol]
  if (!source) return
  const current = scrollOffset.get(source) ?? 0
  scrollOffset.set(source, Math.max(0, current + delta))
  renderSplitView()
}

function handleSplitCmd(cmd: string): void {
  const cmdLower = cmd.toLowerCase()

  if (cmdLower === '/export') {
    doExport(); renderSplitView(); return
  }

  if (cmdLower.startsWith('/tab')) {
    const arg = cmd.slice(4).trim()
    const sources = Array.from(filterState.knownSources.keys())
    if (!arg || arg === '0' || arg.toLowerCase() === 'all') {
      filterState.focusedSource = null
    } else {
      const n = parseInt(arg, 10)
      filterState.focusedSource = !isNaN(n)
        ? (sources[n - 1] ?? null)
        : (sources.find((s) => s.toLowerCase() === arg.toLowerCase()) ?? null)
    }
    writeLine(formatFocusChange(filterState.focusedSource))
    renderSplitView(); return
  }

  if (cmdLower.startsWith('/split')) {
    const arg = cmd.slice(6).trim()
    const argLower = arg.toLowerCase()
    if (!arg || argLower === 'off') {
      filterState.splitSources = null
      columnBuffers.clear()
      exitSplitMode()  // exits raw mode, resumes rl
      return
    }
    const sources = Array.from(filterState.knownSources.keys())
    const tokens = arg.split(/[\s,]+/)
    let selected: string[]
    if (tokens.length === 1 && /^\d$/.test(tokens[0])) {
      selected = sources.slice(0, Math.min(parseInt(tokens[0], 10), 3))
    } else {
      selected = tokens.map((a) => {
        const n = parseInt(a, 10)
        return !isNaN(n) ? sources[n - 1] : sources.find((s) => s.toLowerCase() === a.toLowerCase())
      }).filter((s): s is string => !!s)
    }
    if (selected.length >= 2) {
      exitSplitMode()
      columnBuffers.clear()
      filterState.splitSources = selected
      enterSplitMode()
    } else {
      writeLine(pc.dim('  need at least 2 sources'))
      renderSplitView()
    }
    return
  }

  writeLine(pc.dim(`  not available in split mode — try /export /tab /split off`))
  renderSplitView()
}

function onSplitKey(raw: Buffer | string): void {
  const key = Buffer.isBuffer(raw) ? raw.toString('utf8') : raw

  if (key === '\u0003') { process.exit(0) }

  // Scroll: Up/Down arrows
  if (key === '\x1B[A') { scrollFocused(3); return }
  if (key === '\x1B[B') { scrollFocused(-3); return }
  // PgUp / PgDn
  if (key === '\x1B[5~') { scrollFocused(10); return }
  if (key === '\x1B[6~') { scrollFocused(-10); return }
  // Focus: Left/Right arrows or Tab
  if (key === '\x1B[D' || key === '\t') {
    focusedCol = (focusedCol - 1 + (filterState.splitSources?.length ?? 1)) % (filterState.splitSources?.length ?? 1)
    renderSplitView(); return
  }
  if (key === '\x1B[C') {
    focusedCol = (focusedCol + 1) % (filterState.splitSources?.length ?? 1)
    renderSplitView(); return
  }

  // Enter: execute command buffer
  if (key === '\r' || key === '\n') {
    const cmd = splitCmdBuf.trim()
    splitCmdBuf = ''
    if (cmd) handleSplitCmd(cmd)
    else renderSplitView()
    return
  }

  // Backspace
  if (key === '\x7f' || key === '\b') {
    splitCmdBuf = splitCmdBuf.slice(0, -1)
    renderSplitView(); return
  }

  // Printable chars
  if (key.length === 1 && key >= ' ') {
    splitCmdBuf += key
    renderSplitView()
  }
}

function enterSplitMode(): void {
  focusedCol = 0
  splitCmdBuf = ''
  scrollOffset.clear()
  const { scrollRegionEnd } = getSplitGeometry()
  // Restrict scrolling to above the split panel
  process.stdout.write(`\x1B[1;${scrollRegionEnd}r`)
  // Position cursor at bottom of streaming region
  process.stdout.write(`\x1B[${scrollRegionEnd};1H`)
  if (process.stdin.isTTY) {
    currentRl?.pause()
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.on('data', onSplitKey)
  }
  splitInitialized = true
  renderSplitView()
}

function exitSplitMode(): void {
  process.stdin.removeListener('data', onSplitKey)
  if (process.stdin.isTTY) process.stdin.setRawMode(false)
  currentRl?.resume()
  const { splitStartRow } = getSplitGeometry()
  // Restore full scroll region
  process.stdout.write('\x1B[r')
  // Clear the split panel area
  process.stdout.write(`\x1B[${splitStartRow};1H\x1B[0J`)
  splitInitialized = false
  scrollOffset.clear()
  focusedCol = 0
  splitCmdBuf = ''
}

function writeLineSplit(msg: AltTabMessage): void {
  const source = msg.source
  if (!columnBuffers.has(source)) columnBuffers.set(source, [])
  const buf = columnBuffers.get(source)!

  let line: string
  if ((msg as NetworkMessage).type === 'network') {
    const n = msg as NetworkMessage
    const size = n.responseSize >= 0 ? n.responseSize : n.requestSize
    const matchedSource = handleCorrelation(n)
    line = formatNetworkCompact(n.source, n.method, n.url, n.status, n.duration, size, matchedSource)
  } else {
    const l = msg as { source: string; message: string; level?: string; file?: string; line?: number }
    line = formatLog(l.source, l.message, l.level, l.file, l.line)
  }

  // formatLog embeds \n for streaming wrapping — flatten to a single line
  // so wrapEntry can re-wrap cleanly at the column width
  const flatLine = line.replace(/\n\s*/g, ' ')

  buf.push(flatLine)
  if (buf.length > (SPLIT_LINES + 1) * 3) buf.splice(0, buf.length - SPLIT_LINES - 1)
  renderSplitView()
}

function writeLine(line: string): void {
  if (outputPaused) { outputQueue.push({ line }); return }
  process.stdout.write(line + '\n')
}

function writeMessage(msg: AltTabMessage, line: string): void {
  if (outputPaused) { outputQueue.push({ line, msg }); return }
  if (filterState.splitSources?.includes(msg.source)) {
    writeLineSplit(msg)
  } else {
    process.stdout.write(line + '\n')
  }
}

function pauseOutput(): void {
  outputPaused = true
}

function resumeOutput(): void {
  outputPaused = false
  for (const { line, msg } of outputQueue) {
    if (msg && filterState.splitSources?.includes(msg.source)) {
      writeLineSplit(msg)
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
  sourcesLastSeen.set(msg.source, Date.now())
  if (!shouldShow(msg)) return

  let line: string

  if ((msg as NetworkMessage).type === 'network') {
    const n = msg as NetworkMessage
    // In split mode, handleCorrelation is called inside writeLineSplit — skip here
    const matchedSource = filterState.splitSources?.includes(n.source) ? undefined : handleCorrelation(n)
    line = ts() + formatNetwork(
      n.source, n.method, n.url, n.status,
      n.duration, n.responseSize, n.requestSize,
      n.direction, matchedSource,
    )
  } else if ((msg as RagMessage).type === 'rag') {
    line = ts() + formatRag(msg as RagMessage)
  } else {
    const l = msg as { source: string; message: string; level?: string; file?: string; line?: number }
    line = ts() + formatLog(l.source, l.message, l.level, l.file, l.line)
  }

  appendToBuffer(msg, line)
  writeMessage(msg, line)
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

// ── HTTP log API ──────────────────────────────────────────────────────────

const sourcesLastSeen = new Map<string, number>()
const connectedSources = new Set<string>()
const markers = new Map<string, { label: string; time: number }>()

// eslint-disable-next-line no-control-regex
const stripAnsiHttp = (s: string) => s.replace(/\x1B\[[0-9;]*m/g, '')

const MARK_NOT_FOUND = -1

function parseSince(s: string | null): number {
  if (!s) return 0
  if (s.startsWith('mark_')) {
    const t = markers.get(s)?.time
    return t !== undefined ? t : MARK_NOT_FOUND
  }
  const dm = s.match(/^(\d+)(ms|s|m|h)$/)
  if (dm) {
    const n = parseInt(dm[1], 10)
    const ms = dm[2] === 'ms' ? n : dm[2] === 's' ? n * 1000 : dm[2] === 'm' ? n * 60000 : n * 3600000
    return Date.now() - ms
  }
  return parseInt(s, 10) || 0
}

/** Parse a ?limit= or ?n= param, clamped to [1, max]. Negative/zero/NaN → default. */
function parseLimit(s: string | null, def: number, max: number): number {
  const n = parseInt(s ?? '', 10)
  return Math.min(Math.max(Number.isFinite(n) && n > 0 ? n : def, 1), max)
}

/** Parse a duration string like "10s", "2m", "500ms" → milliseconds. Returns defaultMs on parse failure. */
function parseDuration(s: string | null, defaultMs: number): number {
  if (!s) return defaultMs
  const m = s.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)$/)
  if (!m) return parseInt(s, 10) || defaultMs
  const n = parseFloat(m[1])
  return m[2] === 'ms' ? n : m[2] === 's' ? n * 1000 : m[2] === 'm' ? n * 60000 : n * 3600000
}

function normalizePath(url: string): string {
  try { return new URL(url).pathname } catch { return url.split('?')[0] }
}

function serialize(entries: ReturnType<typeof getAllBuffer>, text = false) {
  if (text) return entries.map((e) => stripAnsiHttp(e.rendered)).join('\n')
  return entries.map((e) => ({ time: e.time, rendered: stripAnsiHttp(e.rendered), ...e.msg }))
}

function respond(res: ServerResponse, data: unknown, text: boolean): void {
  if (text) {
    res.setHeader('Content-Type', 'text/plain')
    res.writeHead(200)
    res.end(typeof data === 'string' ? data : JSON.stringify(data, null, 2))
  } else {
    res.writeHead(200)
    res.end(JSON.stringify(data))
  }
}

function handleHttpRequest(req: IncomingMessage, res: ServerResponse): void {
  const { URL } = require('node:url') as typeof import('node:url')
  const url = new URL(req.url ?? '/', `http://localhost`)
  const fmt = url.searchParams.get('format')
  const text = fmt === 'text'

  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Access-Control-Allow-Origin', '*')

  // ── POST /mark ───────────────────────────────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/mark') {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      let label = 'mark'
      if (body) {
        try { label = (JSON.parse(body) as { label?: string }).label ?? 'mark' }
        catch { res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid JSON body' })); return }
      }
      const time = Date.now()
      const id = `mark_${time}_${markers.size}`
      markers.set(id, { label, time })
      res.writeHead(200)
      res.end(JSON.stringify({ id, label, time }))
    })
    return
  }

  if (req.method !== 'GET') {
    res.writeHead(405)
    res.end(JSON.stringify({ error: 'Method not allowed' }))
    return
  }

  const buf = getAllBuffer()

  // ── GET /logs ────────────────────────────────────────────────────────────
  if (url.pathname === '/logs') {
    const source = url.searchParams.get('source')
    const level  = url.searchParams.get('level')
    const type   = url.searchParams.get('type')
    const since  = parseSince(url.searchParams.get('since'))
    const limit  = parseLimit(url.searchParams.get('n') ?? url.searchParams.get('limit'), 200, 2000)
    let entries  = buf
    if (since)  entries = entries.filter((e) => e.time >= since)
    if (source) entries = entries.filter((e) => e.msg.source === source)
    if (type === 'network') entries = entries.filter((e) => (e.msg as NetworkMessage).type === 'network')
    if (type === 'log')     entries = entries.filter((e) => (e.msg as NetworkMessage).type !== 'network')
    if (level)  entries = entries.filter((e) => (e.msg as { level?: string }).level === level)
    respond(res, serialize(entries.slice(-limit), text), text)
    return
  }

  // ── GET /errors ──────────────────────────────────────────────────────────
  if (url.pathname === '/errors') {
    const source = url.searchParams.get('source')
    const since  = parseSince(url.searchParams.get('since'))
    const limit  = parseLimit(url.searchParams.get('limit'), 50, 500)
    let entries = buf.filter((e) => {
      const m = e.msg as { level?: string; type?: string; status?: number }
      return m.level === 'error' || (m.type === 'network' && (m.status ?? 0) >= 500)
    })
    if (since)  entries = entries.filter((e) => e.time >= since)
    if (source) entries = entries.filter((e) => e.msg.source === source)
    respond(res, serialize(entries.slice(-limit), text), text)
    return
  }

  // ── GET /network ─────────────────────────────────────────────────────────
  if (url.pathname === '/network') {
    const source    = url.searchParams.get('source')
    const statusStr = url.searchParams.get('status')
    const statusN   = statusStr !== null && statusStr !== '' ? parseInt(statusStr, 10) : null
    const since     = parseSince(url.searchParams.get('since'))
    const limit     = parseLimit(url.searchParams.get('limit'), 100, 1000)
    let entries = buf.filter((e) => (e.msg as NetworkMessage).type === 'network')
    if (since)                              entries = entries.filter((e) => e.time >= since)
    if (source)                             entries = entries.filter((e) => e.msg.source === source)
    if (statusN !== null && !isNaN(statusN)) entries = entries.filter((e) => ((e.msg as NetworkMessage).status ?? 0) === statusN)
    respond(res, serialize(entries.slice(-limit), text), text)
    return
  }

  // ── GET /summary ─────────────────────────────────────────────────────────
  if (url.pathname === '/summary') {
    const sources = Array.from(filterState.knownSources.entries()).map(([name, counts]) => ({
      name, ...counts,
      lastSeen: sourcesLastSeen.get(name) ?? null,
    }))
    const errorCount = buf.filter((e) => {
      const m = e.msg as { level?: string; type?: string; status?: number }
      return m.level === 'error' || (m.type === 'network' && (m.status ?? 0) >= 500)
    }).length
    respond(res, { sources, total: buf.length, errors: errorCount, port: PORT }, text)
    return
  }

  // ── GET /sources ─────────────────────────────────────────────────────────
  if (url.pathname === '/sources') {
    const now = Date.now()
    const window1m = now - 60000
    const sources = Array.from(filterState.knownSources.entries()).map(([name, counts]) => {
      const msgs = buf.filter((e) => e.msg.source === name)
      const recent = msgs.filter((e) => e.time >= window1m)
      const errors = msgs.filter((e) => {
        const m = e.msg as { level?: string; type?: string; status?: number }
        return m.level === 'error' || (m.type === 'network' && (m.status ?? 0) >= 500)
      })
      return {
        name,
        connected: connectedSources.has(name),
        logs: counts.logs,
        network: counts.network,
        errors: errors.length,
        lastSeen: sourcesLastSeen.get(name) ?? null,
        msgsPerMin: recent.length,
      }
    })
    respond(res, sources, text)
    return
  }

  // ── GET /timeline ─────────────────────────────────────────────────────────
  if (url.pathname === '/timeline') {
    const sinceRaw = url.searchParams.get('since') ?? '5m'
    const since    = parseSince(sinceRaw)
    if (since === MARK_NOT_FOUND) {
      res.writeHead(404)
      res.end(JSON.stringify({ error: `Mark not found: ${sinceRaw}` }))
      return
    }
    const source = url.searchParams.get('source')
    const limit  = parseLimit(url.searchParams.get('limit'), 500, 2000)
    let entries  = buf.filter((e) => e.time >= since)
    if (source) entries = entries.filter((e) => e.msg.source === source)
    respond(res, serialize(entries.slice(-limit), text), text)
    return
  }

  // ── GET /search ──────────────────────────────────────────────────────────
  if (url.pathname === '/search') {
    const q      = url.searchParams.get('q') ?? ''
    const source = url.searchParams.get('source')
    const type   = url.searchParams.get('type')
    const limit  = parseLimit(url.searchParams.get('limit'), 100, 1000)
    if (!q) { res.writeHead(400); res.end(JSON.stringify({ error: 'q param required' })); return }
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
    let entries = buf.filter((e) => re.test(stripAnsiHttp(e.rendered)))
    if (source) entries = entries.filter((e) => e.msg.source === source)
    if (type === 'network') entries = entries.filter((e) => (e.msg as NetworkMessage).type === 'network')
    if (type === 'log')     entries = entries.filter((e) => (e.msg as NetworkMessage).type !== 'network')
    respond(res, serialize(entries.slice(-limit), text), text)
    return
  }

  // ── GET /slow ────────────────────────────────────────────────────────────
  if (url.pathname === '/slow') {
    const threshold = parseInt(url.searchParams.get('ms') ?? '500', 10)
    const source    = url.searchParams.get('source')
    const limit     = parseLimit(url.searchParams.get('limit'), 50, 500)
    let entries = buf.filter((e) => {
      const n = e.msg as NetworkMessage
      return n.type === 'network' && n.duration >= threshold
    })
    if (source) entries = entries.filter((e) => e.msg.source === source)
    entries = [...entries].sort((a, b) => (b.msg as NetworkMessage).duration - (a.msg as NetworkMessage).duration)
    respond(res, serialize(entries.slice(0, limit), text), text)
    return
  }

  // ── GET /repeat ──────────────────────────────────────────────────────────
  if (url.pathname === '/repeat') {
    const since  = parseSince(url.searchParams.get('since') ?? '5m')
    const source = url.searchParams.get('source')
    const minRaw = parseInt(url.searchParams.get('min') ?? '2', 10)
    const min    = Number.isFinite(minRaw) ? Math.max(1, minRaw) : 2
    let entries  = buf.filter((e) => e.time >= since)
    if (source) entries = entries.filter((e) => e.msg.source === source)
    const counts = new Map<string, { count: number; source: string; lastSeen: number; rendered: string }>()
    for (const e of entries) {
      const key = e.msg.source + ':' + stripAnsiHttp(e.rendered).trim()
      const ex = counts.get(key)
      if (ex) { ex.count++; ex.lastSeen = e.time }
      else counts.set(key, { count: 1, source: e.msg.source, lastSeen: e.time, rendered: stripAnsiHttp(e.rendered).trim() })
    }
    const repeated = [...counts.values()]
      .filter((v) => v.count >= min)
      .sort((a, b) => b.count - a.count)
    respond(res, repeated, text)
    return
  }

  // ── GET /context ─────────────────────────────────────────────────────────
  if (url.pathname === '/context') {
    const at       = parseInt(url.searchParams.get('at') ?? '0', 10)
    const halfMs   = parseDuration(url.searchParams.get('window'), 10000)
    const source   = url.searchParams.get('source')
    if (!at) { res.writeHead(400); res.end(JSON.stringify({ error: 'at= (unix ms timestamp) required' })); return }
    let entries = buf.filter((e) => e.time >= at - halfMs && e.time <= at + halfMs)
    if (source) entries = entries.filter((e) => e.msg.source === source)
    respond(res, serialize(entries, text), text)
    return
  }

  // ── GET /trace ────────────────────────────────────────────────────────────
  if (url.pathname === '/trace') {
    const targetPath = url.searchParams.get('url')
    const method     = (url.searchParams.get('method') ?? '').toUpperCase()
    const limit      = parseLimit(url.searchParams.get('limit'), 10, 50)
    if (!targetPath) { res.writeHead(400); res.end(JSON.stringify({ error: 'url= param required' })); return }

    const netEntries = buf.filter((e) => {
      const n = e.msg as NetworkMessage
      if (n.type !== 'network') return false
      if (normalizePath(n.url) !== normalizePath(targetPath)) return false
      if (method && n.method.toUpperCase() !== method) return false
      return true
    })

    // Pair outgoing (frontend) with incoming (backend) by time proximity.
    // If no outgoing entries exist (only backend connected), fall back to incoming-only chains.
    const outgoing = netEntries.filter((e) => (e.msg as NetworkMessage).direction === 'outgoing')
    const incoming = netEntries.filter((e) => (e.msg as NetworkMessage).direction === 'incoming')

    const anchors = outgoing.length > 0 ? outgoing.slice(-limit) : incoming.slice(-limit)

    const chains = anchors.map((anchor) => {
      const anchorMsg = anchor.msg as NetworkMessage
      const isOutgoing = anchorMsg.direction === 'outgoing'
      // Find the closest counterpart within 3s
      const counterparts = isOutgoing ? incoming : outgoing
      const match = counterparts.find((e) => Math.abs(e.time - anchor.time) < 3000)
      const matchMsg = match ? (match.msg as NetworkMessage) : null
      const start = anchor.time
      const end   = match ? match.time + (matchMsg?.duration ?? 0) : anchor.time + (anchorMsg.duration ?? 0)
      // Logs that fired between request start and end+200ms
      const logs = buf.filter((e) => {
        const n = e.msg as NetworkMessage
        if (n.type === 'network') return false
        return e.time >= start && e.time <= end + 200
      })
      const outMsg = isOutgoing ? anchorMsg : matchMsg
      const incMsg = isOutgoing ? matchMsg : anchorMsg
      const outEntry = isOutgoing ? anchor : match
      const incEntry = isOutgoing ? match : anchor
      return {
        method: anchorMsg.method.toUpperCase(),
        url: targetPath,
        frontend: outMsg && outEntry ? {
          source: outMsg.source,
          time: outEntry.time,
          status: outMsg.status,
          duration: outMsg.duration,
          responseSize: outMsg.responseSize,
        } : null,
        backend: incMsg && incEntry ? {
          source: incMsg.source,
          time: incEntry.time,
          status: incMsg.status,
          duration: incMsg.duration,
        } : null,
        logs: logs.map((e) => ({
          source: e.msg.source,
          message: (e.msg as { message?: string }).message ?? '',
          time: e.time,
        })),
      }
    })

    respond(res, chains, text)
    return
  }

  // ── GET /rag ─────────────────────────────────────────────────────────────
  if (url.pathname === '/rag' || url.pathname.startsWith('/rag/')) {
    const ragBuf = buf.filter((e) => (e.msg as RagMessage).type === 'rag')

    if (url.pathname === '/rag') {
      const source = url.searchParams.get('source')
      const event  = url.searchParams.get('event')
      const since  = parseSince(url.searchParams.get('since') ?? '1h')
      const limit  = parseLimit(url.searchParams.get('limit'), 100, 1000)
      let entries  = ragBuf.filter((e) => e.time >= since)
      if (source) entries = entries.filter((e) => e.msg.source === source)
      if (event)  entries = entries.filter((e) => (e.msg as RagMessage).event === event)
      respond(res, serialize(entries.slice(-limit), text), text)
      return
    }

    if (url.pathname === '/rag/trace') {
      const query  = url.searchParams.get('query') ?? ''
      const source = url.searchParams.get('source')
      const limit  = parseLimit(url.searchParams.get('limit'), 5, 20)

      // Group RAG events into chains by proximity (events within 30s of each other)
      const events = ragBuf.filter((e) => {
        if (source && e.msg.source !== source) return false
        const r = e.msg as RagMessage
        if (query && r.query && !r.query.toLowerCase().includes(query.toLowerCase())) return false
        return true
      })

      // Find retrieve events as chain anchors
      const retrieves = events.filter((e) => (e.msg as RagMessage).event === 'retrieve')
      const chains = retrieves.slice(-limit).map((ret) => {
        const retMsg = ret.msg as RagMessage
        const chainEnd = ret.time + 30000
        const chain = events.filter((e) => e.time >= ret.time && e.time <= chainEnd && e.msg.source === ret.msg.source)
        const steps = chain.map((e) => {
          const r = e.msg as RagMessage
          return { event: r.event, duration_ms: r.duration_ms, ...r }
        })
        return {
          query: retMsg.query,
          source: retMsg.source,
          time: ret.time,
          total_ms: steps.reduce((s, e) => s + (e.duration_ms ?? 0), 0),
          steps,
        }
      })
      respond(res, chains, text)
      return
    }

    if (url.pathname === '/rag/quality') {
      const since = parseSince(url.searchParams.get('since') ?? '1h')
      const issues: Array<{ type: string; source: string; query?: string; detail: string; time: number }> = []

      for (const e of ragBuf.filter((e) => e.time >= since)) {
        const r = e.msg as RagMessage
        if (r.event === 'retrieve') {
          if (r.topScore != null && r.topScore < 0.7)
            issues.push({ type: 'low_retrieval_score', source: r.source, query: r.query, detail: `top score ${r.topScore.toFixed(2)} < 0.7`, time: e.time })
          if ((r.count ?? 0) === 0)
            issues.push({ type: 'empty_retrieval', source: r.source, query: r.query, detail: 'no results returned', time: e.time })
        }
        if (r.event === 'prompt' && r.truncated)
          issues.push({ type: 'context_truncated', source: r.source, detail: `${r.tokens_total} tokens, context was cut`, time: e.time })
        if (r.event === 'generate' && (r.duration_ms ?? 0) > 3000)
          issues.push({ type: 'slow_generation', source: r.source, detail: `${r.duration_ms}ms`, time: e.time })
        if (r.event === 'generate' && r.finish_reason === 'length')
          issues.push({ type: 'generation_cut_off', source: r.source, detail: 'finish_reason: length — response was truncated by token limit', time: e.time })
        if (r.event === 'retrieve' && (r.duration_ms ?? 0) > 2000)
          issues.push({ type: 'slow_retrieval', source: r.source, query: r.query, detail: `${r.duration_ms}ms`, time: e.time })
      }
      respond(res, issues, text)
      return
    }

    if (url.pathname === '/rag/slow') {
      const threshold = parseInt(url.searchParams.get('ms') ?? '1000', 10)
      const since     = parseSince(url.searchParams.get('since') ?? '1h')
      const slow = ragBuf
        .filter((e) => e.time >= since && (e.msg as RagMessage).duration_ms != null && (e.msg as RagMessage).duration_ms! >= threshold)
        .sort((a, b) => (b.msg as RagMessage).duration_ms! - (a.msg as RagMessage).duration_ms!)
      respond(res, serialize(slow.slice(0, 50), text), text)
      return
    }
  }

  // ── GET / ─────────────────────────────────────────────────────────────────
  respond(res, {
    endpoints: {
      '/logs':        'GET  ?source= &level= &type=log|network &since=30s &limit=200',
      '/errors':      'GET  ?since= &limit=50',
      '/network':     'GET  ?source= &status=<exact> &since= &limit=100',
      '/summary':     'GET  — sources + counts',
      '/sources':     'GET  — per-source health: errors, rate, lastSeen',
      '/timeline':    'GET  ?since=5m &source= &limit=500',
      '/search':      'GET  ?q=text &source= &type=log|network &limit=100',
      '/slow':        'GET  ?ms=500 &source= &limit=50',
      '/repeat':      'GET  ?since=5m &source= &min=2',
      '/context':     'GET  ?at=<unix_ms> &window=10s',
      '/trace':       'GET  ?url=/api/path &method=GET &limit=10',
      '/mark':        'POST { label } → { id, time }  — then use ?since=mark_<id>',
      '/rag':         'GET  ?source= &event=retrieve|rerank|prompt|generate &since=1h &limit=100',
      '/rag/trace':   'GET  ?query= &source= &limit=5  — RAG pipeline chains',
      '/rag/quality': 'GET  ?since=1h  — retrieval quality issues',
      '/rag/slow':    'GET  ?ms=1000 &since=1h  — slow RAG operations',
    },
    tip: 'Add ?format=text to any endpoint for plain text output',
  }, text)
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Load or create config via setup wizard
  let config = loadConfig()
  if (!config) {
    config = await runSetupWizard().catch(() => null)
  }

  // Start WebSocket + HTTP server
  const server = createServer({
    port: PORT,
    onMessage,
    onConnect: (source) => { connectedSources.add(source); writeLine(formatSeparator(source, 'connected')) },
    onDisconnect: (source) => { connectedSources.delete(source); writeLine(formatSeparator(source, 'disconnected')) },
    onHttpRequest: handleHttpRequest,
  })

  server.on('listening', () => {
    console.log(formatBanner(PORT, config))
  })

  server.on('error', (err: NodeJS.ErrnoException) => {
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
    currentRl = rl

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
        const sources = Array.from(filterState.knownSources.keys())

        if (!arg || argLower === 'off') {
          // /split off → exit; /split alone → toggle
          if (filterState.splitSources || argLower === 'off') {
            filterState.splitSources = null
            columnBuffers.clear()
            exitSplitMode()
          } else {
            if (sources.length < 2) {
              process.stdout.write(pc.dim('  no sources connected yet\n'))
            } else {
              columnBuffers.clear()
              filterState.splitSources = sources.slice(0, 3)
              enterSplitMode()
            }
          }
        } else {
          // /split 2   → pick first 2 sources by count
          // /split 1 2 → pick sources by index
          // /split react fastapi → pick by name
          const tokens = arg.split(/[\s,]+/)
          let selected: string[]

          if (tokens.length === 1 && /^\d$/.test(tokens[0])) {
            // Single digit = number of columns
            const n = Math.min(parseInt(tokens[0], 10), 3)
            selected = sources.slice(0, n)
          } else {
            selected = tokens.map((a) => {
              const n = parseInt(a, 10)
              return !isNaN(n)
                ? sources[n - 1]
                : sources.find((s) => s.toLowerCase() === a.toLowerCase())
            }).filter((s): s is string => !!s)
          }

          if (selected.length < 2) {
            const list = sources.length
              ? sources.map((s, i) => `  ${pc.dim(`[${i + 1}]`)}  ${s}`).join('\n')
              : pc.dim('  no sources connected yet')
            process.stdout.write(`${list}\n  usage: /split 2  or  /split react fastapi\n`)
          } else {
            if (filterState.splitSources) exitSplitMode()
            columnBuffers.clear()
            filterState.splitSources = selected
            enterSplitMode()
          }
        }
      }
    })

    rl.on('close', () => process.exit(0))
  }

  process.on('SIGINT', () => {
    process.stdout.write('\n' + pc.dim('tablog shutting down…') + '\n')
    server.close()
    process.exit(0)
  })
}

main().catch((err) => {
  console.error(pc.red('tablog failed to start:'), err)
  process.exit(1)
})
