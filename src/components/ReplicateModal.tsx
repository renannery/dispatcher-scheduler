import { CalendarRange, X } from 'lucide-react'
import { useMemo, useState } from 'react'

import { useSchedulerStore } from '@/store/schedulerStore'
import { planReplication, replicateToNewPeriod } from '@/utils/replicate'

const DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const iso = (d: Date) => d.toISOString().slice(0, 10)
const addDays = (dateStr: string, n: number) => {
  const d = new Date(dateStr + 'T12:00:00')
  d.setDate(d.getDate() + n)
  return iso(d)
}

interface Props {
  onClose: () => void
}

/**
 * "Replicate to a new period" — stamp the current schedule's pattern onto a new
 * date range by day-of-week (never a date offset), then flag every violation the
 * new context introduces without auto-repairing. Preview shows the DOW mapping
 * and the flag summary before the user confirms.
 */
export function ReplicateModal({ onClose }: Props) {
  const schedule = useSchedulerStore((s) => s.schedule)
  const dispatchers = useSchedulerStore((s) => s.dispatchers)
  const timeOff = useSchedulerStore((s) => s.timeOff)
  const coverageOverrides = useSchedulerStore((s) => s.coverageOverrides)
  const replicateToPeriod = useSchedulerStore((s) => s.replicateToPeriod)

  const sourceStart = schedule?.dates[0]?.date ?? ''
  const sourceEnd = schedule?.dates[schedule.dates.length - 1]?.date ?? ''
  const sourceLen = schedule?.dates.length ?? 0

  // Default target: immediately after the source, same length.
  const [targetStart, setTargetStart] = useState(() => (sourceEnd ? addDays(sourceEnd, 1) : ''))
  const [targetEnd, setTargetEnd] = useState(() =>
    sourceEnd && sourceLen ? addDays(sourceEnd, sourceLen) : '',
  )

  const valid = !!schedule && !!targetStart && !!targetEnd && targetStart <= targetEnd

  const preview = useMemo(() => {
    if (!schedule || !valid) return null
    const plan = planReplication(schedule, targetStart, targetEnd)
    const { schedule: result } = replicateToNewPeriod(
      schedule, dispatchers, timeOff, coverageOverrides, targetStart, targetEnd,
    )
    const targetDateSet = new Set(plan.targetDates.map((t) => t.date))

    // Flag summary over the replicated block only.
    let rest = 0, supervision = 0, blockConflict = 0
    for (const [date, ws] of Object.entries(result.coverageWarnings ?? {})) {
      if (!targetDateSet.has(date)) continue
      for (const w of ws) {
        if (w.peak === 'rest-violation') rest++
        else if (w.peak === 'supervision') supervision++
        else if (w.peak === 'block-conflict') blockConflict++
      }
    }
    // Coverage shortfalls (live-rendered, but summarise here too).
    let coverageShortSlots = 0
    for (const t of plan.targetDates) {
      const req = result.coverageRequired?.[t.date] ?? []
      const act = result.coverageActual[t.date] ?? []
      req.forEach((r, i) => { if (r > 0 && (act[i] ?? 0) < r) coverageShortSlots++ })
    }

    // DOW alignment for a representative week (target DOW → source DOW label).
    const dowRows = plan.targetDates.slice(0, 7).map((t) => {
      const m = plan.map.find((x) => x.targetDate === t.date)!
      return { targetDate: t.date, targetDow: t.dayOfWeek, sourceDate: m.sourceDate }
    })

    return { plan, result, rest, supervision, blockConflict, coverageShortSlots, dowRows }
  }, [schedule, dispatchers, timeOff, coverageOverrides, targetStart, targetEnd, valid])

  const apply = () => {
    if (!valid) return
    replicateToPeriod(targetStart, targetEnd)
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4" onClick={onClose}>
      <div
        className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between border-b border-slate-100 px-5 py-4">
          <div className="flex items-center gap-2">
            <CalendarRange className="h-5 w-5 text-blue-600" />
            <div>
              <h3 className="text-sm font-bold text-slate-800">Replicate to a new period</h3>
              <p className="text-xs text-slate-500">
                Stamp this schedule's pattern onto new dates by day-of-week. Shifts are copied exactly and any conflicts flagged — nothing is auto-repaired.
              </p>
            </div>
          </div>
          <button onClick={onClose} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          <div className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
            Source: <span className="font-semibold">{sourceStart} → {sourceEnd}</span> ({sourceLen} days,
            starts {sourceStart ? DOW_SHORT[new Date(sourceStart + 'T12:00:00').getDay()] : '—'})
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <label className="text-xs font-medium text-slate-600">
              Target start
              <input
                type="date"
                value={targetStart}
                onChange={(e) => setTargetStart(e.target.value)}
                className="mt-1 block rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
              />
            </label>
            <label className="text-xs font-medium text-slate-600">
              Target end
              <input
                type="date"
                value={targetEnd}
                onChange={(e) => setTargetEnd(e.target.value)}
                className="mt-1 block rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
              />
            </label>
          </div>

          {!valid && (
            <p className="text-xs text-red-600">Pick a valid target range (start on or before end).</p>
          )}

          {preview && (
            <>
              {/* DOW mapping — explicit so the alignment is legible */}
              <div>
                <h4 className="text-[11px] font-bold uppercase tracking-wide text-slate-400">Day-of-week mapping</h4>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {preview.dowRows.map((r) => (
                    <span key={r.targetDate ?? r.targetDow} className="rounded bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-700">
                      source {DOW_SHORT[r.targetDow]} → target {DOW_SHORT[r.targetDow]}
                    </span>
                  ))}
                </div>
                {preview.plan.notices.length > 0 && (
                  <ul className="mt-2 space-y-1">
                    {preview.plan.notices.map((n, i) => (
                      <li key={i} className={`rounded px-2 py-1 text-[11px] ${preview.plan.startDowMismatch && i === 0 ? 'bg-amber-50 text-amber-700' : 'bg-slate-50 text-slate-500'}`}>
                        {preview.plan.startDowMismatch && i === 0 ? '⚠ ' : ''}{n}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* Flag summary over the replicated block */}
              <div>
                <h4 className="text-[11px] font-bold uppercase tracking-wide text-slate-400">
                  Flags in the replicated block <span className="font-normal text-slate-400">(you adjust these manually)</span>
                </h4>
                <div className="mt-1 flex flex-wrap gap-2 text-[11px] font-semibold">
                  <Flag label="rest violations" n={preview.rest} tone="rose" />
                  <Flag label="trainee cover gaps" n={preview.supervision} tone="rose" />
                  <Flag label="blocked shifts" n={preview.blockConflict} tone="amber" />
                  <Flag label="under-coverage slots" n={preview.coverageShortSlots} tone="amber" />
                </div>
                {preview.rest + preview.supervision + preview.blockConflict + preview.coverageShortSlots === 0 && (
                  <p className="mt-1 text-[11px] text-emerald-600">No conflicts — the pattern replicates cleanly into this period.</p>
                )}
              </div>
            </>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-slate-100 px-5 py-3">
          <button onClick={onClose} className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">
            Cancel
          </button>
          <button
            onClick={apply}
            disabled={!valid}
            className="flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <CalendarRange className="h-4 w-4" />
            Replicate &amp; extend schedule
          </button>
        </div>
      </div>
    </div>
  )
}

function Flag({ label, n, tone }: { label: string; n: number; tone: 'rose' | 'amber' }) {
  const active = n > 0
  const cls = !active
    ? 'bg-slate-100 text-slate-400'
    : tone === 'rose'
      ? 'bg-rose-100 text-rose-700'
      : 'bg-amber-100 text-amber-700'
  return <span className={`rounded px-2 py-0.5 ${cls}`}>{n} {label}</span>
}
