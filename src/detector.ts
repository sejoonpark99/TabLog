/**
 * Auto-detects the frontend framework or backend runtime.
 * Override with the ALT_TAB_SOURCE environment variable (or window.__ALT_TAB_SOURCE in browser).
 */
export function detectFramework(): string {
  // ── Explicit override ────────────────────────────────────────────────────
  if (typeof process !== 'undefined' && process.env?.ALT_TAB_SOURCE) {
    return process.env.ALT_TAB_SOURCE
  }

  // ── Browser environment ──────────────────────────────────────────────────
  if (typeof window !== 'undefined') {
    const win = window as Record<string, unknown>

    if (win.__ALT_TAB_SOURCE) return String(win.__ALT_TAB_SOURCE)

    // Next.js (must check before React — Next.js apps include React)
    if (win.__NEXT_DATA__) return 'Next.js'

    // Nuxt (must check before Vue)
    if (win.__NUXT__) return 'Nuxt'

    // React
    if (
      win.__REACT_DEVTOOLS_GLOBAL_HOOK__ ||
      (typeof document !== 'undefined' && document.querySelector('[data-reactroot]'))
    ) return 'React'

    // Angular
    if (
      win.ng ||
      (typeof document !== 'undefined' && document.querySelector('[ng-version]'))
    ) return 'Angular'

    // Vue 3 / Vue 2
    if (win.__VUE__ || win.Vue) return 'Vue'

    // Svelte
    if (win.__svelte) return 'Svelte'

    return 'Frontend'
  }

  // ── Node.js / Bun / Deno environment ─────────────────────────────────────
  if (typeof process !== 'undefined') {
    // Next.js server runtime
    if (process.env.NEXT_RUNTIME || process.env.__NEXT_PRIVATE_ORIGIN) return 'Next.js'

    // Bun
    if (typeof (globalThis as Record<string, unknown>).Bun !== 'undefined') {
      // Still check for framework on Bun
    }

    // Check loaded module cache for known frameworks
    try {
      const cache = (require as NodeRequire & { cache?: Record<string, unknown> }).cache ?? {}
      const keys = Object.keys(cache)

      if (keys.some(k => k.includes('/fastify/'))) return 'Fastify'
      if (keys.some(k => k.includes('/express/'))) return 'Express'
      if (keys.some(k => k.includes('/hono/'))) return 'Hono'
      if (keys.some(k => k.includes('/elysia/'))) return 'Elysia'
      if (keys.some(k => k.includes('/koa/'))) return 'Koa'
      if (keys.some(k => k.includes('/@nestjs/'))) return 'NestJS'
    } catch {
      // require.cache not available (ESM context or Bun)
    }

    return 'Node'
  }

  return 'Unknown'
}
