import clsx from 'clsx'
import { CalendarClock, ShoppingBasket, Upload, UserPlus, X } from 'lucide-react'
import { useCallback, useRef, useState } from 'react'
import { useDropzone } from 'react-dropzone'

import { RecurringBlocksEditor } from '@/components/RecurringBlocksEditor'

import { DRIVER_SLOTS } from '../coverageTemplate'
import { useDriverStore } from '../store'

import type { EmploymentType } from '../types'

const TYPES: { value: EmploymentType; label: string; short: string }[] = [
  { value: 'full', label: 'Full-time', short: 'FT' },
  { value: 'part', label: 'Part-time', short: 'PT' },
]

const TYPE_STYLES: Record<EmploymentType, { pill: string; active: string }> = {
  full: {
    pill:   'border-blue-200 bg-white text-blue-600 hover:bg-blue-50',
    active: 'border-blue-600 bg-blue-600 text-white',
  },
  part: {
    pill:   'border-emerald-200 bg-white text-emerald-600 hover:bg-emerald-50',
    active: 'border-emerald-600 bg-emerald-600 text-white',
  },
}

export function DriverInput() {
  const { drivers, addDriver, removeDriver, setEmploymentType, setShopperStatus, toggleRecurringBlock, setStep, partTimeCap } = useDriverStore()
  const [input, setInput] = useState('')
  const [type, setType] = useState<EmploymentType>('full')
  const inputRef = useRef<HTMLInputElement>(null)
  const [openConstraints, setOpenConstraints] = useState<Set<string>>(new Set())

  interface ParsedEntry {
    name: string
    type: EmploymentType
    driverId?: string
    isShopper?: boolean
  }

  // Parse one line of input. If the line is "Name, <term>" (with a recognizable
  // FT/PT token), use that term; otherwise treat all comma-separated parts as
  // bare names that take the currently-selected `type`.
  const parseLine = (line: string): ParsedEntry[] => {
    const parts = line.split(',').map((p) => p.trim()).filter(Boolean)
    if (parts.length === 0) return []
    if (parts.length >= 2) {
      const last = parts[parts.length - 1].toLowerCase().replace(/[\s-]/g, '')
      const isFT = ['full', 'fulltime', 'ft'].includes(last)
      const isPT = ['part', 'parttime', 'pt'].includes(last)
      if (isFT || isPT) {
        const name = parts.slice(0, -1).join(', ').trim()
        return name ? [{ name, type: isFT ? 'full' : 'part' }] : []
      }
    }
    return parts.map((name) => ({ name, type }))
  }

  // Header-driven parser: when the first row maps named columns (any subset of
  // driverId, name, term, isShopper, in any order), use that mapping for the
  // rest of the file. Falls back to parseLine when no header is detected.
  const parseHeader = (line: string): Record<string, number> | null => {
    if (!line) return null
    const cells = line.split(',').map((c) => c.trim().toLowerCase())
    if (!cells.includes('name') && !cells.includes('driverid')) return null
    const idx: Record<string, number> = {}
    cells.forEach((c, i) => { idx[c] = i })
    return idx
  }

  const parseTermToken = (raw: string | undefined): EmploymentType => {
    const v = (raw ?? '').toLowerCase().replace(/[\s-]/g, '')
    if (['part', 'parttime', 'pt'].includes(v)) return 'part'
    return 'full'  // default to full when missing or unrecognized
  }

  const parseBoolToken = (raw: string | undefined): boolean => {
    const v = (raw ?? '').toLowerCase().trim()
    return v === 'true' || v === '1' || v === 'yes' || v === 'y'
  }

  const parseStructuredLine = (line: string, header: Record<string, number>): ParsedEntry | null => {
    const cells = line.split(',').map((c) => c.trim())
    const name = header['name'] != null ? cells[header['name']] : ''
    if (!name) return null
    const driverId = header['driverid'] != null ? cells[header['driverid']] || undefined : undefined
    const employmentType = parseTermToken(header['term'] != null ? cells[header['term']] : undefined)
    const isShopper = header['isshopper'] != null ? parseBoolToken(cells[header['isshopper']]) : false
    return { name, type: employmentType, driverId, isShopper }
  }

  const addAllFromText = (text: string) => {
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0)
    const header = parseHeader(lines[0] ?? '')
    let entries: ParsedEntry[]
    if (header) {
      entries = lines.slice(1).map((l) => parseStructuredLine(l, header)).filter((e): e is ParsedEntry => e !== null)
    } else {
      entries = lines.flatMap(parseLine)
    }
    entries.forEach(({ name, type: t, driverId, isShopper }) => addDriver(name, t, { driverId, isShopper }))
    return entries.length
  }

  const [dropError, setDropError] = useState<string | null>(null)
  const [dropOk, setDropOk] = useState<string | null>(null)

  const onDrop = useCallback(async (accepted: File[]) => {
    setDropError(null)
    setDropOk(null)
    const file = accepted[0]
    if (!file) return
    try {
      const text = await file.text()
      const count = addAllFromText(text)
      if (count === 0) setDropError('No valid rows found.')
      else setDropOk(`Imported ${count} driver${count !== 1 ? 's' : ''} from ${file.name}`)
    } catch {
      setDropError('Failed to read file.')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type])

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { 'text/csv': ['.csv'], 'text/plain': ['.txt'] },
    multiple: false,
    noClick: false,
    noKeyboard: true,
  })

  const handleAdd = () => {
    if (!input.trim()) return
    addAllFromText(input)
    setInput('')
    inputRef.current?.focus()
  }

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleAdd()
  }

  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text')
    // Only intercept if the paste spans multiple lines OR has multiple names —
    // single-token pastes go through the normal input flow.
    const hasMultiline = /\r?\n/.test(text)
    const hasMultipleNames = text.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean).length > 1
    if (hasMultiline || hasMultipleNames) {
      e.preventDefault()
      addAllFromText(text)
      setInput('')
    }
  }

  const partCount = drivers.filter((d) => d.employmentType === 'part').length
  const canContinue = drivers.length >= 1

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-8">
      <div className="flex flex-col gap-3">
        <label className="text-sm font-medium text-slate-600">Add driver</label>

        <div className="flex gap-2">
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKey}
            onPaste={handlePaste}
            placeholder="e.g. Landon"
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

        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-400">Type:</span>
          <div className="flex gap-1.5">
            {TYPES.map(({ value, label }) => {
              const styles = TYPE_STYLES[value]
              return (
                <button
                  key={value}
                  onClick={() => setType(value)}
                  className={clsx(
                    'rounded-lg border px-3 py-1 text-xs font-semibold transition',
                    type === value ? styles.active : styles.pill,
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
          <span className="font-medium text-slate-500">Landon, Tanesha, Javorn</span>.
          Or paste one per line with the term:{' '}
          <span className="font-medium text-slate-500">Reymark, PT</span> /{' '}
          <span className="font-medium text-slate-500">Landon, full-time</span>.
          Part-timers are capped at {partTimeCap}h/week.
        </p>

        {/* CSV drop zone */}
        <div
          {...getRootProps()}
          className={clsx(
            'flex cursor-pointer items-center gap-3 rounded-xl border-2 border-dashed px-4 py-3 text-xs transition',
            isDragActive
              ? 'border-blue-400 bg-blue-50 text-blue-700'
              : 'border-slate-300 bg-slate-50 text-slate-500 hover:border-blue-300 hover:bg-blue-50/40',
          )}
        >
          <input {...getInputProps()} />
          <Upload className="h-4 w-4 shrink-0" />
          <span>
            {isDragActive ? (
              'Drop the CSV here…'
            ) : (
              <>
                <span className="font-medium text-slate-700">Drop a CSV</span> or click to browse.
                Headers supported: <code className="rounded bg-slate-200 px-1 text-[10px]">driverId,name,term,isShopper</code> (any subset, in any order).
              </>
            )}
          </span>
        </div>
        {dropError && <p className="text-xs text-red-600">{dropError}</p>}
        {dropOk && <p className="text-xs text-emerald-600">{dropOk}</p>}
      </div>

      {drivers.length > 0 && (
        <div>
          <div className="mb-3 flex items-center justify-between">
            <span className="text-sm font-semibold text-slate-700">
              {drivers.length} driver{drivers.length !== 1 ? 's' : ''}
            </span>
            {partCount > 0 && (
              <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-medium text-emerald-700">
                {partCount} part-time
              </span>
            )}
          </div>

          <ul className="flex flex-col gap-2">
            {drivers.map((d) => {
              const isOpen = openConstraints.has(d.id)
              const totalBlocks = (d.recurringBlocks ?? []).reduce(
                (s, row) => s + row.filter(Boolean).length,
                0,
              )
              return (
                <li
                  key={d.id}
                  className="flex flex-col gap-2 rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm"
                >
                  <div className="flex items-center gap-3">
                    <div
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-bold text-white"
                      style={{ backgroundColor: d.color }}
                    >
                      {d.name.split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase()}
                    </div>

                    <span className="flex-1 font-medium text-slate-800">{d.name}</span>

                    <div className="flex gap-1">
                      {TYPES.map(({ value, short }) => {
                        const styles = TYPE_STYLES[value]
                        return (
                          <button
                            key={value}
                            onClick={() => setEmploymentType(d.id, value)}
                            title={value === 'full' ? 'Full-time' : `Part-time (max ${partTimeCap}h)`}
                            className={clsx(
                              'rounded-md border px-2 py-0.5 text-[11px] font-bold transition',
                              d.employmentType === value ? styles.active : styles.pill,
                            )}
                          >
                            {short}
                          </button>
                        )
                      })}
                    </div>

                    <button
                      onClick={() => setShopperStatus(d.id, !d.isShopper)}
                      title={d.isShopper ? 'Shopper-driver (clears when toggled off)' : 'Mark as shopper-driver (works at the grocery store, fills in as driver)'}
                      className={clsx(
                        'flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-semibold transition',
                        d.isShopper
                          ? 'border-violet-300 bg-violet-50 text-violet-700 hover:bg-violet-100'
                          : 'border-slate-200 bg-slate-50 text-slate-400 hover:bg-slate-100',
                      )}
                    >
                      <ShoppingBasket className="h-3.5 w-3.5" />
                      Shopper
                    </button>

                    <button
                      onClick={() => setOpenConstraints((prev) => {
                        const next = new Set(prev)
                        if (next.has(d.id)) next.delete(d.id)
                        else next.add(d.id)
                        return next
                      })}
                      title="Recurring weekly breaks"
                      className={clsx(
                        'flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-semibold transition',
                        totalBlocks > 0
                          ? 'border-red-300 bg-red-50 text-red-700 hover:bg-red-100'
                          : 'border-slate-200 bg-slate-50 text-slate-500 hover:bg-slate-100',
                      )}
                    >
                      <CalendarClock className="h-3.5 w-3.5" />
                      {totalBlocks > 0 ? `${totalBlocks}h/wk` : 'breaks'}
                    </button>

                    <button
                      onClick={() => removeDriver(d.id)}
                      className="rounded-lg p-1 text-slate-300 transition hover:bg-red-50 hover:text-red-500"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>

                  {isOpen && (
                    <RecurringBlocksEditor
                      blocks={d.recurringBlocks}
                      slots={DRIVER_SLOTS}
                      accentColor={d.color}
                      onToggle={(dow, si) => toggleRecurringBlock(d.id, dow, si)}
                    />
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      )}

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
