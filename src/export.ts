import fs from 'node:fs'
import path from 'node:path'
import type { AltTabMessage } from './server'

interface BufferedEntry {
  msg: AltTabMessage
  rendered: string
  time: number
}

const sessionBuffer: BufferedEntry[] = []

export function appendToBuffer(msg: AltTabMessage, rendered: string): void {
  sessionBuffer.push({ msg, rendered, time: Date.now() })
}

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*m/g, '')
}

export interface ExportResult {
  jsonPath: string
  logPath: string
  count: number
}

export function exportSession(outputDir = '.'): ExportResult {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`

  const base = path.join(outputDir, `tablog-${stamp}`)
  const jsonPath = `${base}.json`
  const logPath = `${base}.log`

  // Structured JSON — full message data with wall-clock time
  const jsonData = sessionBuffer.map(({ time, msg }) => ({ time, ...msg }))
  fs.writeFileSync(jsonPath, JSON.stringify(jsonData, null, 2), 'utf-8')

  // Human-readable log — ANSI stripped, one line per entry
  const logLines = sessionBuffer.map(({ time, rendered }) => {
    const t = new Date(time).toTimeString().slice(0, 8)
    return `${t}  ${stripAnsi(rendered)}`
  })
  fs.writeFileSync(logPath, logLines.join('\n') + '\n', 'utf-8')

  return { jsonPath, logPath, count: sessionBuffer.length }
}

export function bufferSize(): number {
  return sessionBuffer.length
}
