import clsx from 'clsx'
import { formatDistanceToNow, parseISO } from 'date-fns'
import { Cloud, CloudOff, Headphones, Loader2, Truck } from 'lucide-react'
import { useEffect, useState } from 'react'

import { useDriverStore } from '@/drivers/store'
import { useSchedulerStore } from '@/store/schedulerStore'
import {
  cloudEnabled,
  fetchSavedMetadata,
  fetchSavedSnapshot,
  type SavedScheduleMeta,
} from '@/utils/cloudStorage'
import { fmtRangeShort } from '@/utils/displayHelpers'
import type { DispatcherSnapshotData, DriverSnapshotData, TeamKind } from '@/utils/snapshot'

type CloudMap = Partial<Record<TeamKind, SavedScheduleMeta | null>>

interface Props {
  /** Which teams to surface. Defaults to both — pass a single team
   *  on per-team pages to avoid cross-team noise. */
  teams?: TeamKind[]
  /** Called after a successful hydrate so the parent can route into the
   *  newly-loaded team's schedule view (or do nothing — the store's
   *  hydrate already sets step='schedule'). */
  onLoaded?: (team: TeamKind) => void
  /** Section header text. */
  label?: string
}

const TEAM_META: Record<TeamKind, { icon: React.ReactNode; accent: string; label: string }> = {
  dispatchers: {
    icon: <Headphones className="h-4 w-4 text-blue-600" />,
    accent: 'hover:border-blue-300 hover:bg-blue-50/40',
    label: 'Dispatchers',
  },
  drivers: {
    icon: <Truck className="h-4 w-4 text-emerald-600" />,
    accent: 'hover:border-emerald-300 hover:bg-emerald-50/40',
    label: 'Drivers',
  },
}

/** "Current saved schedule" entry — fetches cloud metadata for the
 *  given teams and renders a one-click load row per team that has
 *  saved data. Hidden entirely when cloud env vars aren't set. */
export function CloudLoadEntry({ teams = ['dispatchers', 'drivers'], onLoaded, label = 'Current saved schedule' }: Props) {
  const hydrateDispatcher = useSchedulerStore((s) => s.hydrateFromSnapshot)
  const hydrateDriver = useDriverStore((s) => s.hydrateFromSnapshot)

  const [cloud, setCloud] = useState<CloudMap | 'loading' | 'error'>(
    cloudEnabled ? 'loading' : {},
  )
  const [err, setErr] = useState<string | null>(null)
  const [loadingTeam, setLoadingTeam] = useState<TeamKind | null>(null)

  useEffect(() => {
    if (!cloudEnabled) return
    let cancelled = false
    Promise.all(teams.map((t) => fetchSavedMetadata(t).then((m) => [t, m] as const)))
      .then((pairs) => {
        if (cancelled) return
        const map: CloudMap = {}
        for (const [t, m] of pairs) map[t] = m
        setCloud(map)
      })
      .catch((e) => {
        if (cancelled) return
        setCloud('error')
        setErr(e instanceof Error ? e.message : 'Cloud read failed')
      })
    return () => { cancelled = true }
    // teams is intentionally a stable input — callers pass a constant array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!cloudEnabled) return null

  const handleLoad = async (team: TeamKind) => {
    setLoadingTeam(team)
    setErr(null)
    try {
      const env = await fetchSavedSnapshot(team)
      if (!env) throw new Error('No saved schedule found')
      if (team === 'dispatchers') hydrateDispatcher(env.data as DispatcherSnapshotData)
      else hydrateDriver(env.data as DriverSnapshotData)
      onLoaded?.(team)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Cloud load failed')
      setLoadingTeam(null)
    }
  }

  let body: React.ReactNode
  if (cloud === 'loading') {
    body = (
      <div className="flex items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-4 text-sm text-slate-500">
        <Loader2 className="h-4 w-4 animate-spin" />
        Checking for saved schedules…
      </div>
    )
  } else if (cloud === 'error') {
    body = (
      <div className="flex items-center gap-2 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
        <CloudOff className="h-4 w-4" />
        Couldn't read from cloud: {err}
      </div>
    )
  } else {
    const present = teams
      .map((t) => ({ team: t, meta: cloud[t] }))
      .filter((r): r is { team: TeamKind; meta: SavedScheduleMeta } => !!r.meta)
    if (present.length === 0) {
      body = (
        <div className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-400">
          <Cloud className="h-4 w-4" />
          No cloud-saved schedule yet — generate one and click Save on the schedule view.
        </div>
      )
    } else {
      body = (
        <div className="flex flex-col gap-2">
          {present.map(({ team, meta }) => {
            const tm = TEAM_META[team]
            const isLoading = loadingTeam === team
            return (
              <button
                key={team}
                type="button"
                onClick={() => handleLoad(team)}
                disabled={loadingTeam !== null}
                className={clsx(
                  'flex items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-left text-sm transition disabled:cursor-not-allowed disabled:opacity-60',
                  !loadingTeam && tm.accent,
                )}
              >
                <div className="flex items-center gap-3">
                  {tm.icon}
                  <div>
                    <div className="font-semibold text-slate-800">{tm.label}</div>
                    <div className="text-xs text-slate-500">
                      {fmtRangeShort(meta.startDate, meta.endDate)}
                      <span className="ml-1 text-slate-400">
                        · saved {formatDistanceToNow(parseISO(meta.updatedAt), { addSuffix: true })}
                      </span>
                    </div>
                  </div>
                </div>
                <span className="flex items-center gap-1.5 text-xs font-semibold text-blue-700">
                  {isLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Cloud className="h-3.5 w-3.5" />}
                  {isLoading ? 'Loading…' : 'Load →'}
                </span>
              </button>
            )
          })}
          {err && <p className="text-center text-xs text-red-600">{err}</p>}
        </div>
      )
    }
  }

  return (
    <div className="w-full">
      <div className="mb-2 text-center text-xs uppercase tracking-wide text-slate-400">{label}</div>
      {body}
    </div>
  )
}
