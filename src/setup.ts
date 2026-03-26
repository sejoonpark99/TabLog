import net from 'node:net'
import readline from 'node:readline'
import fs from 'node:fs'
import { execSync } from 'node:child_process'
import pc from 'picocolors'

// ── Types ─────────────────────────────────────────────────────────────────

export interface ServiceConfig {
  name: string
  port: number
  role: 'frontend' | 'backend'
  pid?: number
}

export interface TablogConfig {
  services: ServiceConfig[]
}

const CONFIG_FILE = 'tablog.config.json'

// ── Ports to scan ─────────────────────────────────────────────────────────

const SCAN_PORTS = [
  3000, 3001, 3002,   // CRA / Next.js / Express
  4000,               // Phoenix (Elixir)
  4200,               // Angular CLI
  5000, 5001,         // Flask / .NET
  5173, 5174, 5175,   // Vite
  8000, 8001,         // FastAPI / Django / uvicorn
  8080,               // Vue CLI / Spring Boot
  8888,               // Jupyter
  9000,               // PHP / misc
]

// ── Detection ─────────────────────────────────────────────────────────────

export interface DetectedService {
  port: number
  name: string
  role: 'frontend' | 'backend' | 'unknown'
  pid?: number
}

function isPortOpen(port: number): Promise<boolean> {
  const tryConnect = (host: string) => new Promise<boolean>((resolve) => {
    const socket = new net.Socket()
    socket.setTimeout(400)
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('timeout', () => { socket.destroy(); resolve(false) })
    socket.once('error', () => resolve(false))
    socket.connect(port, host)
  })
  return Promise.all([tryConnect('127.0.0.1'), tryConnect('::1')]).then(([v4, v6]) => v4 || v6)
}

async function identifyPort(port: number): Promise<DetectedService> {
  try {
    const res = await fetch(`http://localhost:${port}/`, {
      signal: AbortSignal.timeout(1200),
      headers: { Accept: 'text/html,application/json,*/*' },
    })

    const server  = (res.headers.get('server')       ?? '').toLowerCase()
    const powered = (res.headers.get('x-powered-by') ?? '').toLowerCase()
    const ct      = (res.headers.get('content-type') ?? '').toLowerCase()

    // ── Backend — identified from HTTP headers ──────────────────────────
    if (server.includes('uvicorn'))   return { port, name: 'FastAPI',           role: 'backend' }
    if (server.includes('werkzeug'))  return { port, name: 'Flask',             role: 'backend' }
    if (server.includes('gunicorn'))  return { port, name: 'Gunicorn (Python)', role: 'backend' }
    if (server.includes('hypercorn')) return { port, name: 'Hypercorn (Python)',role: 'backend' }
    if (server.includes('daphne'))    return { port, name: 'Django (Daphne)',   role: 'backend' }
    if (powered.includes('express'))  return { port, name: 'Express',           role: 'backend' }
    if (powered.includes('nestjs'))   return { port, name: 'NestJS',            role: 'backend' }
    if (powered.includes('next.js'))  return { port, name: 'Next.js',           role: 'frontend' }

    // ── Frontend — Vite ping endpoint (most reliable) ───────────────────
    const vitePing = await fetch(`http://localhost:${port}/__vite_ping`, {
      signal: AbortSignal.timeout(400),
    }).catch(() => null)
    if (vitePing?.ok) return { port, name: 'Vite', role: 'frontend' }

    // ── Frontend — Next.js static assets ────────────────────────────────
    const nextStatic = await fetch(`http://localhost:${port}/_next/static/`, {
      method: 'HEAD',
      signal: AbortSignal.timeout(400),
    }).catch(() => null)
    if (nextStatic && (nextStatic.status === 200 || nextStatic.status === 403)) {
      return { port, name: 'Next.js', role: 'frontend' }
    }

    // ── Fallback — infer from content-type + port heuristics ────────────
    if (ct.includes('text/html'))        return { port, name: inferFrontend(port), role: 'frontend' }
    if (ct.includes('application/json')) return { port, name: `API :${port}`,      role: 'backend'  }

    return { port, name: `Service :${port}`, role: 'unknown' }
  } catch {
    // Port is open (TCP) but HTTP failed — likely non-HTTP or very slow
    return { port, name: `Service :${port}`, role: 'unknown' }
  }
}

/** Single netstat/lsof call → port→pid map for all LISTENING sockets. */
function getListeningPids(): Map<number, number> {
  const map = new Map<number, number>()
  try {
    if (process.platform === 'win32') {
      const out = execSync('netstat -ano -p TCP', { encoding: 'utf8', timeout: 2000 })
      for (const line of out.split('\n')) {
        const m = line.match(/\bTCP\b\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i)
        if (m) map.set(parseInt(m[1], 10), parseInt(m[2], 10))
      }
    } else {
      // Linux: ss; macOS: lsof fallback
      try {
        const out = execSync('ss -tlnpH', { encoding: 'utf8', timeout: 1000 })
        for (const line of out.split('\n')) {
          const portM = line.match(/:(\d+)\s/)
          const pidM  = line.match(/pid=(\d+)/)
          if (portM && pidM) map.set(parseInt(portM[1], 10), parseInt(pidM[1], 10))
        }
      } catch {
        const out = execSync('lsof -nP -i TCP -sTCP:LISTEN', { encoding: 'utf8', timeout: 2000 })
        for (const line of out.split('\n')) {
          const m = line.match(/\s+(\d+)\s+.*TCP\s+\S+:(\d+)\s/)
          if (m) map.set(parseInt(m[2], 10), parseInt(m[1], 10))
        }
      }
    }
  } catch {
    // PID detection is best-effort — silently skip
  }
  return map
}

function inferFrontend(port: number): string {
  const map: Record<number, string> = {
    3000: 'React / CRA',
    4200: 'Angular',
    5173: 'Vite',
    5174: 'Vite',
    8080: 'Vue CLI',
  }
  return map[port] ?? `Frontend :${port}`
}

export async function scanServices(skipPort?: number): Promise<DetectedService[]> {
  process.stdout.write(pc.dim('  scanning') + ' ')

  const portsToPoll = SCAN_PORTS.filter((p) => p !== skipPort)

  // TCP probe in parallel
  const results = await Promise.all(
    portsToPoll.map(async (p) => {
      const open = await isPortOpen(p)
      process.stdout.write(pc.dim('.'))
      return { port: p, open }
    }),
  )

  process.stdout.write('\n')

  const openPorts = results.filter((r) => r.open).map((r) => r.port)
  if (openPorts.length === 0) return []

  // HTTP identification in parallel for open ports
  const services = await Promise.all(openPorts.map((p) => identifyPort(p)))

  // Annotate with PIDs (single system call)
  const pids = getListeningPids()
  for (const svc of services) {
    const pid = pids.get(svc.port)
    if (pid !== undefined) svc.pid = pid
  }

  return services
}

// ── Config file ───────────────────────────────────────────────────────────

export function loadConfig(): TablogConfig | null {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')) as TablogConfig
  } catch {
    return null
  }
}

export function saveConfig(config: TablogConfig): void {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8')
}

// ── Setup wizard ──────────────────────────────────────────────────────────

function ask(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => rl.question(prompt, resolve))
}

function roleLabel(role: DetectedService['role']): string {
  if (role === 'frontend') return pc.blue('frontend')
  if (role === 'backend')  return pc.green('backend')
  return pc.dim('unknown')
}

export async function runSetupWizard(tablogPort: number): Promise<TablogConfig> {
  if (!process.stdin.isTTY) {
    // Non-interactive — return empty config, will auto-update on first connect
    return { services: [] }
  }

  console.log('\n' + pc.bold(pc.cyan('  tablog')) + pc.dim('  detecting running services...\n'))

  const detected = await scanServices(tablogPort)

  if (detected.length === 0) {
    console.log(pc.dim('  No services found on common ports.'))
    console.log(pc.dim('  Start your frontend and backend, then re-run tablog.\n'))
    return { services: [] }
  }

  // Print service list
  detected.forEach((s, i) => {
    const pidStr = s.pid !== undefined ? pc.dim(`  pid ${s.pid}`) : ''
    console.log(
      `  ${pc.dim(`[${i + 1}]`)}  ${pc.bold(`:${s.port}`).padEnd(8)}  ${s.name.padEnd(22)}  ${roleLabel(s.role)}${pidStr}`,
    )
  })
  console.log()

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

  const allNums = detected.map((_, i) => i + 1).join(' ')
  const prompt = `  Select services to monitor ${pc.dim(`[${allNums} / Enter for all]`)}: `
  const raw = (await ask(rl, prompt)).trim()

  rl.close()

  // Parse selection — empty = all, otherwise space/comma-separated numbers
  let selectedIdxs: number[]
  if (!raw) {
    selectedIdxs = detected.map((_, i) => i)
  } else {
    selectedIdxs = raw
      .split(/[\s,]+/)
      .map((t) => parseInt(t, 10) - 1)
      .filter((i) => i >= 0 && i < detected.length)
    // Deduplicate
    selectedIdxs = [...new Set(selectedIdxs)]
  }

  const services: ServiceConfig[] = selectedIdxs.map((i) => {
    const s = detected[i]
    return {
      name: s.name,
      port: s.port,
      role: s.role === 'unknown' ? 'backend' : s.role,
      ...(s.pid !== undefined && { pid: s.pid }),
    }
  })

  const config: TablogConfig = { services }
  saveConfig(config)
  console.log(pc.dim(`\n  Saved to ${CONFIG_FILE}\n`))

  return config
}
