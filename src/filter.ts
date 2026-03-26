import readline from 'node:readline'
import pc from 'picocolors'
import type { AltTabMessage } from './server'
import type { NetworkMessage } from './network'

export interface FilterState {
  hiddenSources: Set<string>
  showLogs: boolean
  showNetwork: boolean
  knownSources: Map<string, { logs: number; network: number }>
  focusedSource: string | null  // null = show all
  splitSources: string[] | null  // null = interleaved mode
}

export const filterState: FilterState = {
  hiddenSources: new Set(),
  showLogs: true,
  showNetwork: true,
  knownSources: new Map(),
  focusedSource: null,
  splitSources: null,
}

export function registerMessage(msg: AltTabMessage): void {
  const entry = filterState.knownSources.get(msg.source) ?? { logs: 0, network: 0 }
  if ((msg as NetworkMessage).type === 'network') entry.network++
  else entry.logs++
  filterState.knownSources.set(msg.source, entry)
}

export function shouldShow(msg: AltTabMessage): boolean {
  if (filterState.focusedSource !== null && msg.source !== filterState.focusedSource) return false
  if (filterState.hiddenSources.has(msg.source)) return false
  const isNet = (msg as NetworkMessage).type === 'network'
  if (isNet && !filterState.showNetwork) return false
  if (!isNet && !filterState.showLogs) return false
  return true
}

function renderMenu(sources: [string, { logs: number; network: number }][]): string[] {
  const W = 62
  const border = pc.dim('─'.repeat(W))

  const lines: string[] = [
    '',
    pc.dim(`  ┌─ filter ${'─'.repeat(W - 9)}┐`),
  ]

  if (sources.length === 0) {
    lines.push(pc.dim('  │  No sources connected yet.') + ' '.repeat(W - 28) + pc.dim('│'))
  } else {
    sources.forEach(([src, counts], i) => {
      const hidden = filterState.hiddenSources.has(src)
      const check = hidden ? pc.dim('✗') : pc.green('✓')
      const num = pc.dim(`[${i + 1}]`)
      const name = src.padEnd(14)
      const stats = pc.dim(
        `${counts.logs} log${counts.logs !== 1 ? 's' : ''}  ${counts.network} req${counts.network !== 1 ? 's' : ''}`,
      )
      const hiddenBadge = hidden ? '  ' + pc.dim('hidden') : ''
      lines.push(`  │  ${num} ${check}  ${name} ${stats}${hiddenBadge}`)
    })
  }

  const netStatus = filterState.showNetwork ? pc.green('on') : pc.dim('off')
  const logStatus = filterState.showLogs ? pc.green('on') : pc.dim('off')
  lines.push(`  │`)
  lines.push(`  │  ${pc.dim('[n]')} network ${netStatus}    ${pc.dim('[l]')} logs ${logStatus}`)
  lines.push(`  │  ${pc.dim('[Enter / q]')}  back to stream`)
  lines.push(`  ${pc.dim('└' + '─'.repeat(W + 2) + '┘')}`)
  lines.push('')
  return lines
}

export function openFilterMenu(
  rl: readline.Interface,
  pauseOutput: () => void,
  resumeOutput: () => void,
): void {
  if (!process.stdin.isTTY) {
    process.stdout.write(pc.dim('  /change requires an interactive terminal\n'))
    return
  }

  rl.pause()
  pauseOutput()

  const sources = Array.from(filterState.knownSources.entries())
  let currentLines = renderMenu(sources)

  function draw(): void {
    process.stdout.write(currentLines.join('\n') + '\n')
  }

  function clearDraw(): void {
    // Move cursor up and clear each line
    for (let i = 0; i < currentLines.length; i++) {
      process.stdout.write('\x1B[1A\x1B[2K')
    }
    currentLines = renderMenu(sources)
    draw()
  }

  draw()

  process.stdin.setRawMode(true)
  process.stdin.resume()

  function onKey(key: string): void {
    // Ctrl+C → exit process
    if (key === '\u0003') {
      cleanup()
      process.stdout.write('\n')
      process.exit(0)
    }

    // Enter or q → close menu
    if (key === '\r' || key === '\n' || key === 'q' || key === 'Q') {
      cleanup()
      return
    }

    // Number → toggle source
    const num = parseInt(key, 10)
    if (!isNaN(num) && num >= 1 && num <= sources.length) {
      const src = sources[num - 1][0]
      if (filterState.hiddenSources.has(src)) filterState.hiddenSources.delete(src)
      else filterState.hiddenSources.add(src)
      clearDraw()
      return
    }

    // n → toggle network
    if (key === 'n' || key === 'N') {
      filterState.showNetwork = !filterState.showNetwork
      clearDraw()
      return
    }

    // l → toggle logs
    if (key === 'l' || key === 'L') {
      filterState.showLogs = !filterState.showLogs
      clearDraw()
      return
    }
  }

  function cleanup(): void {
    process.stdin.removeListener('data', onKey)
    if (process.stdin.isTTY) process.stdin.setRawMode(false)
    rl.resume()
    resumeOutput()
  }

  process.stdin.on('data', onKey)
}
