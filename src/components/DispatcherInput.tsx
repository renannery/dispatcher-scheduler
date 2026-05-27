import clsx from 'clsx'
import { UserPlus, X } from 'lucide-react'
import { useRef, useState } from 'react'

import { useSchedulerStore } from '@/store/schedulerStore'
import type { DispatcherLevel } from '@/types/schedule'

// ---------------------------------------------------------------------------
// Level meta
// ---------------------------------------------------------------------------

const LEVELS: { value: DispatcherLevel; label: string; short: string }[] = [
  { value: 'Trainee', label: 'Trainee', short: 'TR' },
  { value: 'Regular', label: 'Regular', short: 'RG' },
  { value: 'Senior',  label: 'Senior',  short: 'SR' },
]

const LEVEL_STYLES: Record<DispatcherLevel, { pill: string; active: string }> = {
  Trainee: {
    pill:   'border-slate-200 bg-white text-slate-500 hover:bg-slate-50',
    active: 'border-slate-400 bg-slate-500 text-white',
  },
  Regular: {
    pill:   'border-blue-200 bg-white text-blue-600 hover:bg-blue-50',
    active: 'border-blue-600 bg-blue-600 text-white',
  },
  Senior: {
    pill:   'border-amber-200 bg-white text-amber-600 hover:bg-amber-50',
    active: 'border-amber-500 bg-amber-500 text-white',
  },
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DispatcherInput() {
  const { dispatchers, addDispatcher, removeDispatcher, setDispatcherLevel, setStep } =
    useSchedulerStore()

  const [input, setInput]   = useState('')
  const [level, setLevel]   = useState<DispatcherLevel>('Regular')
  const inputRef = useRef<HTMLInputElement>(null)

  const handleAdd = () => {
    const names = input.split(',').map((n) => n.trim()).filter(Boolean)
    if (names.length === 0) return
    names.forEach((n) => addDispatcher(n, level))
    setInput('')
    inputRef.current?.focus()
  }

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleAdd()
  }

  // Paste multiple names — all get the currently selected level
  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const text  = e.clipboardData.getData('text')
    const names = text.split(/[\n,]+/).map((n) => n.trim()).filter(Boolean)
    if (names.length > 1) {
      e.preventDefault()
      names.forEach((n) => addDispatcher(n, level))
      setInput('')
    }
  }

  const seniorCount  = dispatchers.filter((d) => d.level === 'Senior').length
  const canContinue  = dispatchers.length >= 1

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-8">

      {/* ── Add dispatcher form ─────────────────────────────────────────── */}
      <div className="flex flex-col gap-3">
        <label className="text-sm font-medium text-slate-600">Add dispatcher</label>

        {/* Name input + Add button */}
        <div className="flex gap-2">
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKey}
            onPaste={handlePaste}
            placeholder="e.g. Maria Santos"
            autoFocus
            className="flex-1 rounded-xl border border-slate-300 bg-white px-4 py-3 text-slate-800 placeholder-slate-400 shadow-sm outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-200"
          />
          <button
            onClick={handleAdd}
            disabled={!input.trim()}
            className="flex items-center gap-2 rounded-xl bg-blue-600 px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-700 disabled:opacity-40"
          >
            <UserPlus className="h-4 w-4" />
            Add
          </button>
        </div>

        {/* Level selector */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-400">Level:</span>
          <div className="flex gap-1.5">
            {LEVELS.map(({ value, label }) => {
              const styles = LEVEL_STYLES[value]
              return (
                <button
                  key={value}
                  onClick={() => setLevel(value)}
                  className={clsx(
                    'rounded-lg border px-3 py-1 text-xs font-semibold transition',
                    level === value ? styles.active : styles.pill,
                  )}
                >
                  {label}
                </button>
              )
            })}
          </div>
        </div>

        <p className="text-xs text-slate-400">
          Separate multiple names with commas — e.g.{' '}
          <span className="font-medium text-slate-500">Ayrton, Kimberly, Paula</span>
        </p>
      </div>

      {/* ── Dispatcher list ─────────────────────────────────────────────── */}
      {dispatchers.length > 0 && (
        <div>
          <div className="mb-3 flex items-center justify-between">
            <span className="text-sm font-semibold text-slate-700">
              {dispatchers.length} dispatcher{dispatchers.length !== 1 ? 's' : ''}
            </span>
            {seniorCount === 0 && dispatchers.length > 0 && (
              <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-700">
                ⚠ No Senior assigned
              </span>
            )}
          </div>

          <ul className="flex flex-col gap-2">
            {dispatchers.map((d) => (
              <li
                key={d.id}
                className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm"
              >
                {/* Avatar */}
                <div
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-bold text-white"
                  style={{ backgroundColor: d.color }}
                >
                  {d.name.split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase()}
                </div>

                {/* Name */}
                <span className="flex-1 font-medium text-slate-800">{d.name}</span>

                {/* Level pills */}
                <div className="flex gap-1">
                  {LEVELS.map(({ value, short }) => {
                    const styles = LEVEL_STYLES[value]
                    return (
                      <button
                        key={value}
                        onClick={() => setDispatcherLevel(d.id, value)}
                        title={value}
                        className={clsx(
                          'rounded-md border px-2 py-0.5 text-[11px] font-bold transition',
                          d.level === value ? styles.active : styles.pill,
                        )}
                      >
                        {short}
                      </button>
                    )
                  })}
                </div>

                {/* Remove */}
                <button
                  onClick={() => removeDispatcher(d.id)}
                  className="rounded-lg p-1 text-slate-300 transition hover:bg-red-50 hover:text-red-500"
                >
                  <X className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ── Continue ────────────────────────────────────────────────────── */}
      <div className="flex justify-end pt-2">
        <button
          disabled={!canContinue}
          onClick={() => setStep('period')}
          className="rounded-xl bg-blue-600 px-8 py-3 text-sm font-semibold text-white shadow transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Set Schedule Period →
        </button>
      </div>
    </div>
  )
}
