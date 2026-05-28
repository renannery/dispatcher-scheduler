import clsx from 'clsx'
import { useState } from 'react'

import { HoverHint } from '@/components/HoverHint'
import { ABSENCE_REASONS, reasonColors, reasonLabel, type AbsenceReason } from '@/utils/absence'
import { shortHour } from '@/utils/displayHelpers'

interface Slot {
  label: string
  hours: number
}

interface Props {
  minDate: string
  maxDate: string
  /** Slot definitions for the team (15 for drivers, 19 for dispatchers). */
  slots: Slot[]
  /**
   * Apply the absence. `slotMask` is undefined for an all-day absence;
   * otherwise a bitmap (length = slots.length) of slots to block on every
   * date in [start, end].
   */
  onApply: (
    startDate: string,
    endDate: string,
    reason: AbsenceReason,
    slotMask: boolean[] | undefined,
  ) => void
  onCancel: () => void
}

type Mode = 'allDay' | 'specificHours'

export function AbsenceRangeForm({ minDate, maxDate, slots, onApply, onCancel }: Props) {
  const [start, setStart] = useState(minDate)
  const [end, setEnd] = useState(minDate)
  const [reason, setReason] = useState<AbsenceReason>('vacation')
  const [mode, setMode] = useState<Mode>('allDay')
  const [hourFrom, setHourFrom] = useState(0)
  const [hourTo, setHourTo] = useState(slots.length - 1)

  const dateValid = start && end && end >= start
  const hourValid = mode === 'allDay' || (hourFrom >= 0 && hourTo >= hourFrom)
  const valid = dateValid && hourValid

  const handleApply = () => {
    if (!valid) return
    if (mode === 'allDay') {
      onApply(start, end, reason, undefined)
    } else {
      const mask = new Array(slots.length).fill(false)
      for (let i = hourFrom; i <= hourTo; i++) mask[i] = true
      onApply(start, end, reason, mask)
    }
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50/50 p-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1">
          <label className="text-[10px] font-medium uppercase tracking-wide text-slate-400">From</label>
          <input
            type="date"
            value={start}
            min={minDate}
            max={maxDate}
            onChange={(e) => {
              const s = e.target.value
              setStart(s)
              if (end < s) setEnd(s)
            }}
            className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-800 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-200"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-[10px] font-medium uppercase tracking-wide text-slate-400">To</label>
          <input
            type="date"
            value={end}
            min={start || minDate}
            max={maxDate}
            onChange={(e) => setEnd(e.target.value)}
            className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-800 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-200"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-[10px] font-medium uppercase tracking-wide text-slate-400">Reason</label>
          <div className="flex gap-1">
            {ABSENCE_REASONS.map(({ value, short }) => {
              const c = reasonColors(value)
              const active = reason === value
              return (
                <HoverHint key={value} label={reasonLabel(value)}>
                  <button
                    type="button"
                    onClick={() => setReason(value)}
                    className={clsx(
                      'rounded border px-1.5 py-1 text-[10px] font-bold transition',
                      active ? c.tw : 'border-slate-200 bg-white text-slate-500 hover:bg-slate-100',
                    )}
                  >
                    {short}
                  </button>
                </HoverHint>
              )
            })}
          </div>
        </div>
      </div>

      {/* Scope: all day vs specific hours */}
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1">
          <label className="text-[10px] font-medium uppercase tracking-wide text-slate-400">Scope</label>
          <div className="flex gap-1">
            {(['allDay', 'specificHours'] as Mode[]).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={clsx(
                  'rounded border px-2 py-1 text-[10px] font-semibold transition',
                  mode === m
                    ? 'border-blue-600 bg-blue-600 text-white'
                    : 'border-slate-200 bg-white text-slate-500 hover:bg-slate-100',
                )}
              >
                {m === 'allDay' ? 'All day' : 'Specific hours'}
              </button>
            ))}
          </div>
        </div>

        {mode === 'specificHours' && (
          <>
            <div className="flex flex-col gap-1">
              <label className="text-[10px] font-medium uppercase tracking-wide text-slate-400">Hour from</label>
              <select
                value={hourFrom}
                onChange={(e) => {
                  const v = Number(e.target.value)
                  setHourFrom(v)
                  if (hourTo < v) setHourTo(v)
                }}
                className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-800 outline-none focus:border-blue-500"
              >
                {slots.map((s, i) => (
                  <option key={i} value={i}>{shortHour(s.label)}</option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[10px] font-medium uppercase tracking-wide text-slate-400">Hour to</label>
              <select
                value={hourTo}
                onChange={(e) => setHourTo(Number(e.target.value))}
                className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-800 outline-none focus:border-blue-500"
              >
                {slots.map((s, i) => (
                  <option key={i} value={i} disabled={i < hourFrom}>{shortHour(s.label)}</option>
                ))}
              </select>
            </div>
          </>
        )}

        <div className="ml-auto flex gap-1.5">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!valid}
            onClick={handleApply}
            className="rounded-md bg-blue-600 px-3 py-1 text-xs font-semibold text-white shadow-sm transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  )
}
