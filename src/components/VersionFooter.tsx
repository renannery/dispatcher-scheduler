/**
 * Tiny footer showing the build's commit SHA + build time. Lets ops
 * confirm at a glance which version of the algorithm they're testing
 * (especially useful when verifying that a Vercel deploy actually
 * shipped — the SHA changes on every push to main).
 *
 * Hover the chip to see the full build timestamp.
 *
 * Values come from vite.config.ts `define` block: VERCEL_GIT_COMMIT_SHA
 * on production builds, falling back to local `git rev-parse --short HEAD`.
 */
export function VersionFooter() {
  const version = __APP_VERSION__
  const buildTime = __APP_BUILD_TIME__
  // Format the build time as a short local date/time
  const buildDate = (() => {
    try {
      const d = new Date(buildTime)
      return d.toLocaleString(undefined, {
        month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit',
      })
    } catch {
      return buildTime
    }
  })()

  return (
    <footer className="border-t border-slate-200 bg-white px-6 py-2 text-center text-[10px] text-slate-400">
      <span title={`Built ${buildTime}`}>
        v{version} · built {buildDate}
      </span>
    </footer>
  )
}
