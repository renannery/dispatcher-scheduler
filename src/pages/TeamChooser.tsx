import clsx from 'clsx'
import { Headphones, Truck, Upload } from 'lucide-react'
import { useCallback, useState } from 'react'
import { useDropzone } from 'react-dropzone'

import { useDriverStore } from '@/drivers/store'
import { useSchedulerStore } from '@/store/schedulerStore'
import {
  parseSnapshot,
  type DispatcherSnapshotData,
  type DriverSnapshotData,
} from '@/utils/snapshot'

interface Props {
  onPick: (team: 'dispatchers' | 'drivers') => void
}

export function TeamChooser({ onPick }: Props) {
  const hydrateDriver = useDriverStore((s) => s.hydrateFromSnapshot)
  const hydrateDispatcher = useSchedulerStore((s) => s.hydrateFromSnapshot)

  const [importError, setImportError] = useState<string | null>(null)
  const [importOk, setImportOk] = useState<string | null>(null)

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

  return (
    <div className="min-h-screen bg-slate-100">
      <main className="mx-auto flex max-w-3xl flex-col items-center px-6 pt-20 pb-10">
        <div className="mb-10 text-center">
          <h1 className="text-3xl font-bold text-slate-900">Bento Scheduler</h1>
          <p className="mt-2 text-slate-500">Pick which team you're scheduling for.</p>
        </div>

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
