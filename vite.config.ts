import { execSync } from 'node:child_process'
import path from 'node:path'

import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Resolve the commit SHA from (in order): Vercel's build env var, local git,
// or a fallback string. Vercel sets VERCEL_GIT_COMMIT_SHA on prod/preview
// builds; local `pnpm dev` falls through to `git rev-parse`.
function resolveCommitSha(): string {
  if (process.env.VERCEL_GIT_COMMIT_SHA) return process.env.VERCEL_GIT_COMMIT_SHA.slice(0, 7)
  try {
    return execSync('git rev-parse --short HEAD').toString().trim()
  } catch {
    return 'dev'
  }
}

const APP_VERSION = resolveCommitSha()
const APP_BUILD_TIME = new Date().toISOString()

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
    __APP_BUILD_TIME__: JSON.stringify(APP_BUILD_TIME),
  },
})
