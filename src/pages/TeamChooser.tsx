import clsx from 'clsx'
import { formatDistanceToNow, parseISO } from 'date-fns'
import { Cloud, CloudOff, Headphones, Loader2, Truck, Upload } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useDropzone } from 'react-dropzone'

import { useDriverStore } from '@/drivers/store'
import { useSchedulerStore } from '@/store/schedulerStore'
import {
  cloudEnabled,
  fetchSavedMetadata,
  fetchSavedSnapshot,
  type SavedScheduleMeta,
} from '@/utils/cloudStorage'
import { fmtRangeShort } from '@/utils/displayHelpers'
import {
  parseSnapshot,
  type DispatcherSnapshotData,
  type DriverSnapshotData,
  type TeamKind,
} from '@/utils/snapshot'

interface Props {
  onPick: (team: 'dispatchers' | 'drivers') => void
}

interface CloudState {
  dispatchers: SavedScheduleMeta | null
  drivers: SavedScheduleMeta | null
}

export function TeamChooser({ onPick }: Props) {
  const hydrateDriver = useDriverStore((s) => s.hydrateFromSnapshot)
  const hydrateDispatcher = useSchedulerStore((s) => s.hydrateFromSnapshot)

  const [importError, setImportError] = useState<string | null>(null)
  const [importOk, setImportOk] = useState<string | null>(null)

  // Cloud-saved schedules: fetch metadata for both teams in parallel
  // on mount, so the user can pick one and jump straight to the
  // schedule view without walking through Names + Period.
  const [cloud, setCloud] = useState<CloudState | 'loading' | 'error'>(
    cloudEnabled ? 'loading' : { dispatchers: null, drivers: null },
  )
  const [cloudErr, setCloudErr] = useState<string | null>(null)
  const [loadingTeam, setLoadingTeam] = useState<TeamKind | null>(null)

  useEffect(() => {
    if (!cloudEnabled) return
    let cancelled = false
    Promise.all([fetchSavedMetadata('dispatchers'), fetchSavedMetadata('drivers')])
      .then(([d, r]) => { if (!cancelled) setCloud({ dispatchers: d, drivers: r }) })
      .catch((e) => {
        if (cancelled) return
        setCloud('error')
        setCloudErr(e instanceof Error ? e.message : 'Cloud read failed')
      })
    return () => { cancelled = true }
  }, [])

  const loadFromCloud = async (team: TeamKind) => {
    setLoadingTeam(team)
    try {
      const env = await fetchSavedSnapshot(team)
      if (!env) throw new Error('No saved schedule found')
      if (team === 'dispatchers') hydrateDispatcher(env.data as DispatcherSnapshotData)
      else hydrateDriver(env.data as DriverSnapshotData)
      onPick(team)
    } catch (e) {
      setCloudErr(e instanceof Error ? e.message : 'Cloud load failed')
      setLoadingTeam(null)
    }
  }

  const onDrop = useCallback(async (accepted: File[]) => {
    setImportError(null)
    setImportOk(null)
    const file = accepted[0]
    if (!file) return
    try {
      const text = await file.text()
      const env = parseSnapshot(text)
      if (env.team === 'drivers') {
        hydrateDriver(env.data as DriverSnapshotData)
        setImportOk(`Loaded drivers schedule from ${file.name}`)
        setTimeout(() => onPick('drivers'), 300)
      } else {
        hydrateDispatcher(env.data as DispatcherSnapshotData)
        setImportOk(`Loaded dispatchers schedule from ${file.name}`)
        setTimeout(() => onPick('dispatchers'), 300)
      }
    } catch (e) {
      setImportError(e instanceof Error ? e.message : 'Failed to read file.')
    }
  }, [hydrateDriver, hydrateDispatcher, onPick])

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { 'application/json': ['.json'] },
    multiple: false,
  })

  // Helper: render one cloud row per team, only when that team's gist
  // has data. When the whole cloud read is in flight, show a single
  // loading row instead.
  const renderCloudSection = () => {
    if (!cloudEnabled) return null
    if (cloud === 'loading') {
      return (
        <div className="flex items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-4 text-sm text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin" />
          Checking for saved schedules…
        </div>
      )
    }
    if (cloud === 'error') {
      return (
        <div className="flex items-center gap-2 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <CloudOff className="h-4 w-4" />
          Couldn't read from cloud: {cloudErr}
        </div>
      )
    }
    const rows: { team: TeamKind; meta: SavedScheduleMeta; accent: string; icon: React.ReactNode }[] = []
    if (cloud.dispatchers) {
      rows.push({
        team: 'dispatchers', meta: cloud.dispatchers,
        accent: 'hover:border-blue-300 hover:bg-blue-50/40',
        icon: <Headphones className="h-4 w-4 text-blue-600" />,
      })
    }
    if (cloud.drivers) {
      rows.push({
        team: 'drivers', meta: cloud.drivers,
        accent: 'hover:border-emerald-300 hover:bg-emerald-50/40',
        icon: <Truck className="h-4 w-4 text-emerald-600" />,
      })
    }
    if (rows.length === 0) {
      return (
        <div className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-400">
          <Cloud className="h-4 w-4" />
          No cloud-saved schedules yet — generate one and click Save on the schedule view.
        </div>
      )
    }
    return (
      <div className="flex flex-col gap-2">
        {rows.map(({ team, meta, accent, icon }) => {
          const isLoading = loadingTeam === team
          return (
            <button
              key={team}
              type="button"
              onClick={() => loadFromCloud(team)}
              disabled={loadingTeam !== null}
              className={clsx(
                'flex items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-left text-sm transition disabled:cursor-not-allowed disabled:opacity-60',
                !loadingTeam && accent,
              )}
            >
              <div className="flex items-center gap-3">
                {icon}
                <div>
                  <div className="font-semibold text-slate-800 capitalize">{team}</div>
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
        {cloudErr && <p className="text-center text-xs text-red-600">{cloudErr}</p>}
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-slate-100">
      <main className="mx-auto flex max-w-3xl flex-col items-center px-6 pt-20 pb-10">
        <div className="mb-10 text-center">
          <h1 className="text-3xl font-bold text-slate-900">Bento Scheduler</h1>
          <p className="mt-2 text-slate-500">Pick which team you're scheduling for.</p>
        </div>

        {/* Cloud-saved schedules — shown at the top so the common case
            (load the live schedule, view it) is one click. */}
        {cloudEnabled && (
          <div className="mb-8 w-full">
            <div className="mb-2 text-center text-xs uppercase tracking-wide text-slate-400">
              Current saved schedule
            </div>
            {renderCloudSection()}
          </div>
        )}

        <div className="grid w-full gap-4 sm:grid-cols-2">
          <button
            onClick={() => onPick('dispatchers')}
            className="group flex flex-col items-center gap-4 rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm transition hover:-translate-y-0.5 hover:border-blue-300 hover:shadow-md"
          >
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-blue-600 shadow-sm transition group-hover:scale-105">
              <Headphones className="h-7 w-7 text-white" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-slate-900">Dispatchers</h2>
              <p className="mt-1 text-sm text-slate-500">
                Pattern-based, 19 mixed slots, senior/regular/trainee.
              </p>
            </div>
          </button>

          <button
            onClick={() => onPick('drivers')}
            className="group flex flex-col items-center gap-4 rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm transition hover:-translate-y-0.5 hover:border-emerald-300 hover:shadow-md"
          >
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-emerald-600 shadow-sm transition group-hover:scale-105">
              <Truck className="h-7 w-7 text-white" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-slate-900">Drivers</h2>
              <p className="mt-1 text-sm text-slate-500">
                15 one-hour slots, full-time + part-time caps, BackOffice export.
              </p>
            </div>
          </button>
        </div>

        {/* Or load a previously exported snapshot */}
        <div className="mt-8 w-full">
          <div className="mb-2 text-center text-xs uppercase tracking-wide text-slate-400">
            Or
          </div>
          <div
            {...getRootProps()}
            className={clsx(
              'flex cursor-pointer items-center justify-center gap-3 rounded-2xl border-2 border-dashed px-4 py-5 text-sm transition',
              isDragActive
                ? 'border-blue-400 bg-blue-50 text-blue-700'
                : 'border-slate-300 bg-white text-slate-500 hover:border-blue-300 hover:bg-blue-50/40',
            )}
          >
            <input {...getInputProps()} />
            <Upload className="h-5 w-5 shrink-0" />
            <span>
              {isDragActive ? (
                'Drop the snapshot here…'
              ) : (
                <>
                  <span className="font-medium text-slate-700">Drop a saved snapshot</span> to load an existing schedule.
                  The team is detected from the file.
                </>
              )}
            </span>
          </div>
          {importError && <p className="mt-2 text-center text-xs text-red-600">{importError}</p>}
          {importOk && <p className="mt-2 text-center text-xs text-emerald-600">{importOk}</p>}
        </div>
      </main>
    </div>
  )
}
