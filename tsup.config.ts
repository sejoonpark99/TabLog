import { defineConfig } from 'tsup'

export default defineConfig([
  // CLI — Node.js CJS with shebang
  {
    entry: { cli: 'src/cli.ts' },
    format: ['cjs'],
    platform: 'node',
    banner: { js: '#!/usr/bin/env node' },
    clean: true,
    outDir: 'dist',
  },
  // Client library — ESM + CJS for Node.js, with type declarations
  {
    entry: { index: 'src/index.ts' },
    format: ['esm', 'cjs'],
    platform: 'node',
    dts: true,
    outDir: 'dist',
  },
  // Browser bundle — IIFE, window.Tablog global
  {
    entry: { browser: 'src/index.ts' },
    format: ['iife'],
    platform: 'browser',
    globalName: 'Tablog',
    outDir: 'dist',
    define: {
      'process.env.TABLOG_PORT': 'undefined',
      'process.env.TABLOG_SOURCE': 'undefined',
    },
  },
])
