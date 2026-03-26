import pc from 'picocolors'
import type { TablogConfig } from './setup'

type ColorFn = (s: string) => string

const COLOR_POOL: ColorFn[] = [
  pc.blue,
  pc.green,
  pc.yellow,
  pc.magenta,
  pc.cyan,
  (s) => pc.bold(pc.red(s)),
]

const sourceColors = new Map<string, ColorFn>()
let colorIdx = 0
let maxLabelLen = 7

function getColor(source: string): ColorFn {
  if (!sourceColors.has(source)) {
    sourceColors.set(source, COLOR_POOL[colorIdx % COLOR_POOL.length])
    colorIdx++
  }
  return sourceColors.get(source)!
}

function label(source: string): string {
  const tag = `[${source}]`
  if (tag.length > maxLabelLen) maxLabelLen = tag.length
  return getColor(source)(tag.padEnd(maxLabelLen))
}

/** Wrap and indent text to fit within maxWidth, aligning continuations under col. */
function wrapMessage(text: string, maxWidth: number, col: number): string {
  if (maxWidth < 10) return text
  const pad = ' '.repeat(col)
  const lines = text.split('\n')
  const result: string[] = []
  for (const line of lines) {
    if (line.length <= maxWidth) {
      result.push(line)
    } else {
      let remaining = line
      let first = true
      while (remaining.length > maxWidth) {
        result.push((first ? '' : pad) + remaining.slice(0, maxWidth))
        remaining = remaining.slice(maxWidth)
        first = false
      }
      if (remaining) result.push((first ? '' : pad) + remaining)
    }
  }
  return result.join('\n' + pad)
}

// ── Helpers ───────────────────────────────────────────────────────────────

function fmtSize(bytes: number): string {
  if (bytes < 0) return '?'
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}kB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

function fmtStatus(status: number): string {
  const s = status === 0 ? 'ERR' : String(status)
  if (status === 0 || status >= 500) return pc.red(s.padStart(4))
  if (status >= 400) return pc.yellow(s.padStart(4))
  if (status >= 300) return pc.cyan(s.padStart(4))
  return pc.green(s.padStart(4))
}

function fmtDuration(ms: number): string {
  const s = `${ms}ms`
  if (ms >= 500) return pc.red(s.padStart(7))
  if (ms >= 200) return pc.yellow(s.padStart(7))
  return pc.dim(s.padStart(7))
}

// ── Log line ──────────────────────────────────────────────────────────────

export function formatLog(source: string, message: string, level?: string): string {
  const lbl = label(source)
  const lblLen = lbl.replace(/\x1B\[[0-9;]*m/g, '').length
  // +2 for the two spaces between label and message
  const col = lblLen + 2
  const termWidth = process.stdout.columns || 120
  const msgWidth = termWidth - col
  let text: string
  switch (level) {
    case 'error': text = pc.red(`● ${wrapMessage(message, msgWidth - 2, col + 2)}`); break
    case 'warn':  text = pc.yellow(wrapMessage(message, msgWidth, col)); break
    case 'info':  text = pc.dim(wrapMessage(message, msgWidth, col)); break
    default:      text = wrapMessage(message, msgWidth, col)
  }
  return `${lbl}  ${text}`
}

// ── Network line ──────────────────────────────────────────────────────────

const URL_LEN = 40

export function formatNetwork(
  source: string,
  method: string,
  url: string,
  status: number,
  duration: number,
  responseSize: number,
  requestSize: number,
  direction: 'outgoing' | 'incoming' = 'outgoing',
  matchedSource?: string,
): string {
  const dir = pc.dim(direction === 'incoming' ? 'in ' : 'out')
  const methodStr = pc.bold(method.toUpperCase().padEnd(5))
  const displayUrl =
    url.length > URL_LEN ? `${url.slice(0, URL_LEN - 1)}…` : url.padEnd(URL_LEN)
  const size = responseSize >= 0 ? responseSize : requestSize
  const sizeStr = pc.dim(fmtSize(size).padStart(6))
  const match = matchedSource ? `  ${pc.dim('<>')} ${getColor(matchedSource)(matchedSource)}` : ''

  return `${label(source)}  ${dir}  ${methodStr} ${displayUrl}  ${fmtStatus(status)}  ${fmtDuration(duration)}  ${sizeStr}${match}`
}

// ── Separator (connect / disconnect) ─────────────────────────────────────

export function formatSeparator(source: string, event: 'connected' | 'disconnected'): string {
  const now = new Date().toTimeString().slice(0, 8)
  const text = ` ${source} ${event} `
  const totalWidth = 72
  const dashes = '─'.repeat(Math.max(0, totalWidth - text.length - 8))
  return pc.dim(`── ${text}${dashes} ${now}`)
}

// ── Compact network line (for split-column view) ──────────────────────────

export function formatNetworkCompact(
  source: string,
  method: string,
  url: string,
  status: number,
  duration: number,
  size: number,
  matchedSource?: string,
): string {
  const lbl = label(source)
  const methodStr = pc.bold(method.toUpperCase().padEnd(4))
  const maxUrl = 26
  const displayUrl = url.length > maxUrl ? `${url.slice(0, maxUrl - 1)}…` : url
  const match = matchedSource ? `  ${pc.dim('<>')} ${getColor(matchedSource)(matchedSource)}` : ''
  return `${lbl}  ${fmtStatus(status)}  ${methodStr} ${displayUrl}  ${fmtDuration(duration)}  ${pc.dim(fmtSize(size).padStart(5))}${match}`
}

// ── Tab focus change ──────────────────────────────────────────────────────

export function formatFocusChange(source: string | null): string {
  const now = new Date().toTimeString().slice(0, 8)
  const text = source ? ` viewing: ${source} ` : ` viewing: all `
  const totalWidth = 72
  const dashes = '─'.repeat(Math.max(0, totalWidth - text.length - 8))
  return pc.dim(`── ${text}${dashes} ${now}`)
}

// ── Startup banner ────────────────────────────────────────────────────────

export function formatBanner(port: number, config: TablogConfig | null): string {
  const W = 56
  const top    = `╭─ tablog ${'─'.repeat(W - 9)}╮`
  const bottom = `╰${'─'.repeat(W + 1)}╯`

  function row(content: string): string {
    const stripped = content.replace(/\x1B\[[0-9;]*m/g, '')
    const pad = W - stripped.length
    return `│  ${content}${' '.repeat(Math.max(0, pad - 1))}│`
  }

  const wsLine  = row(`ws://localhost:${port}`)
  const blank   = row('')
  const cmd1    = row(`${pc.dim('/tab')} [1|2|all]  switch  ${pc.dim('/split')} [1|2|off]  columns`)
  const cmd2    = row(`${pc.dim('/change')}  filter  ${pc.dim('/copy')}  copy  ${pc.dim('/export')}  save`)

  let serviceRow = ''
  if (config?.services?.length) {
    const parts = config.services.map(
      (s) => `${getColor(s.name)(s.name)} ${pc.dim(`:${s.port}`)}`,
    )
    serviceRow = '\n' + row(parts.join(pc.dim('  ·  ')))
  }

  return [
    pc.dim(top),
    pc.dim('│') + '  ' + pc.bold(pc.cyan('tablog')) + ' ' + pc.dim(`listening`) + serviceRow.replace(/^\n/, ''),
    serviceRow ? '' : null,
    pc.dim(row('')),
    wsLine,
    pc.dim(blank),
    cmd1,
    cmd2,
    pc.dim(bottom),
  ]
    .filter((l) => l !== null)
    .join('\n')
}
