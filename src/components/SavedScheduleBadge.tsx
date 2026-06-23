import clsx from 'clsx'
import { formatDistanceToNow, parseISO } from 'date-fns'
import { Cloud, CloudOff, CloudUpload, Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'

import {
  cloudEnabled,
  fetchSavedMetadata,
  saveSnapshot,
  type SavedScheduleMeta,
} from '@/utils/cloudStorage'
import { type SnapshotData, type TeamKind } from '@/utils/snapshot'

import { fmtRangeShort } from '@/utils/displayHelpers'

interface Props {
  team: TeamKind
  /** Called to gather the current local snapshot data when the user clicks Save. */
  collectSnapshot: () => SnapshotData
  /** When the badge first mounts, optionally signal that a saved version exists
   *  so the parent can offer to auto-load. Receives the metadata + a fetcher
   *  for the full envelope. Called only when the badge is enabled. */
  onSavedDiscovered?: (meta: SavedScheduleMeta) => void
}

/** Compact "saved version" pill + Save button, mounted in each schedule
 *  page toolbar. Hidden when Supabase env vars aren't set so local-only
 *  installs don't see broken UI. */
export function SavedScheduleBadge({ team, collectSnapshot, onSavedDiscovered }: Props) {
  const [meta, setMeta] = useState<SavedScheduleMeta | null>(null)
  const [status, setStatus] = useState<'idle' | 'loading' | 'saving' | 'error'>('loading')
  const [errMsg, setErrMsg] = useState<string | null>(null)

  // Initial fetch of saved metadata. Runs once on mount per team.
  useEffect(() => {
    if (!cloudEnabled) {
      setStatus('idle')
      return
    }
    let cancelled = false
    setStatus('loading')
    fetchSavedMetadata(team)
      .then((m) => {
        if (cancelled) return
        setMeta(m)
        setStatus('idle')
        if (m && onSavedDiscovered) onSavedDiscovered(m)
      })
      .catch((e: Error) => {
        if (cancelled) return
        setStatus('error')
        setErrMsg(e.message)
      })
    return () => { cancelled = true }
  }, [team, onSavedDiscovered])

  const handleSave = async () => {
    if (status === 'saving') return
    setStatus('saving')
    setErrMsg(null)
    try {
      const snap = collectSnapshot()
      const saved = await saveSnapshot(team, snap)
      setMeta(saved)
      setStatus('idle')
    } catch (e) {
      setStatus('error')
      setErrMsg(e instanceof Error ? e.message : 'Save failed')
    }
  }

  if (!cloudEnabled) return null

  const isError = status === 'error'
  const labelPeriod = meta
    ? fmtRangeShort(meta.startDate, meta.endDate)
    : null
  const labelTime = meta
    ? formatDistanceToNow(parseISO(meta.updatedAt), { addSuffix: true })
    : null

  return (
    <div className="flex items-center gap-2">
      <div
        className={clsx(
          'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium',
          isError
            ? 'border-red-200 bg-red-50 text-red-700'
            : meta
            ? 'border-slate-200 bg-slate-50 text-slate-700'
            : 'border-slate-200 bg-slate-50 text-slate-400',
        )}
        title={
          isError
            ? errMsg ?? 'Cloud error'
            : meta
            ? `Saved schedule covers ${labelPeriod} · last update ${labelTime}`
            : 'No saved schedule yet'
        }
      >
        {status === 'loading'
          ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
          : isError
          ? <CloudOff className="h-3.5 w-3.5" />
          : <Cloud className="h-3.5 w-3.5" />}
        {status === 'loading' && <span>Checking saved…</span>}
        {status !== 'loading' && meta && (
          <span>
            Saved: <span className="font-semibold">{labelPeriod}</span>
            <span className="ml-1 text-slate-400">· {labelTime}</span>
          </span>
        )}
        {status !== 'loading' && !meta && !isError && (
          <span>No saved schedule</span>
        )}
        {isError && <span>Cloud error</span>}
      </div>
      <button
        type="button"
        onClick={handleSave}
        disabled={status === 'saving' || status === 'loading'}
        className={clsx(
          'inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-semibold transition',
          'border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100',
          'disabled:cursor-not-allowed disabled:opacity-50',
        )}
        title="Save the current schedule to the shared cloud copy (overwrites the existing one)."
      >
        {status === 'saving'
          ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
          : <CloudUpload className="h-3.5 w-3.5" />}
        Save
      </button>
    </div>
  )
}
