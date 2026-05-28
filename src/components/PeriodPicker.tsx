import clsx from 'clsx'
import { differenceInDays, format, parseISO } from 'date-fns'
import { CalendarPlus, ChevronDown, ChevronRight, History, Search, Upload, X } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { useDropzone } from 'react-dropzone'

import { AbsenceRangeForm } from '@/components/AbsenceRangeForm'
import { HoverHint } from '@/components/HoverHint'
import { SLOTS } from '@/data/coverageTemplate'
import { useSchedulerStore } from '@/store/schedulerStore'
import { reasonColors, reasonLabel, reasonShort } from '@/utils/absence'
import { longDay, shortHour } from '@/utils/displayHelpers'
import { generateSchedule } from '@/utils/scheduler'
import { parseSnapshot, type DispatcherSnapshotData } from '@/utils/snapshot'

export function PeriodPicker() {
  const {
    dispatchers,
    startDate,
    endDate,
    timeOff,
    absenceReasons,
    weekendRotationOffset,
    setDateRange,
    setSchedule,
    setStep,
    toggleFullDayOff,
    toggleBlockedSlot,
    applyAbsenceRange,
    advanceWeekendRotation,
    importRotationContext,
  } = useSchedulerStore()

  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [absenceFormOpen, setAbsenceFormOpen] = useState<Set<string>>(new Set())
  const [importInfo, setImportInfo] = useState<{ kind: 'ok' | 'err'; msg: string } | null>(null)

  const onDropRotation = useCallback(async (accepted: File[]) => {
    setImportInfo(null)
    const file = accepted[0]
    if (!file) return
    try {
      const env = parseSnapshot(await file.text())
      if (env.team !== 'dispatchers') {
        throw new Error(`This is a ${env.team} snapshot — load it from the driver page.`)
      }
      const data = env.data as DispatcherSnapshotData
      importRotationContext(data)
      setImportInfo({
        kind: 'ok',
        msg: `Loaded ${data.dispatchers.length} dispatchers · rotation cursor ${data.weekendRotationOffset ?? 0}. Pick the new period below.`,
      })
    } catch (e) {
      setImportInfo({ kind: 'err', msg: e instanceof Error ? e.message : 'Failed to read file.' })
    }
  }, [importRotationContext])

  const { getRootProps: getRotationRoot, getInputProps: getRotationInput, isDragActive: isRotationDragActive } = useDropzone({
    onDrop: onDropRotation,
    accept: { 'application/json': ['.json'] },
    multiple: false,
  })

  const totalDays = differenceInDays(parseISO(endDate), parseISO(startDate)) + 1
  const totalWeeks = Math.ceil(totalDays / 7)
  const isValid = startDate && endDate && endDate >= startDate && totalDays >= 7

  const handleGenerate = () => {
    if (!isValid) return
    const schedule = generateSchedule(dispatchers, startDate, endDate, timeOff, weekendRotationOffset)
    setSchedule(schedule)
    const weeksInSchedule = new Set(schedule.dates.map((d) => d.weekLabel)).size
    advanceWeekendRotation(weeksInSchedule)
    setStep('schedule')
  }

  // Build list of all dates in range for the time-off picker
  const allDates: { date: string; label: string }[] = []
  if (isValid) {
    const start = parseISO(startDate)
    for (let i = 0; i < totalDays; i++) {
      const d = new Date(start)
      d.setDate(d.getDate() + i)
      allDates.push({
        date: format(d, 'yyyy-MM-dd'),
        label: longDay(d),
      })
    }
  }

  const [search, setSearch] = useState('')
  const visibleDispatchers = useMemo(() => {
    const q = search.trim().toLowerCase()
    const hasTimeOff = (id: string) => {
      const map = timeOff[id]
      return !!map && Object.values(map).some((bm) => bm?.some(Boolean))
    }
    return dispatchers.filter((d) => {
      const matches = q && d.name.toLowerCase().includes(q)
      return matches || hasTimeOff(d.id)
    })
  }, [dispatchers, timeOff, search])

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-8">
      {/* Continue from a previous schedule */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2 text-sm font-medium text-slate-600">
          <History className="h-4 w-4" />
          Continue from a previous schedule
        </div>
        <div
          {...getRotationRoot()}
          className={clsx(
            'flex cursor-pointer items-center gap-3 rounded-xl border-2 border-dashed px-4 py-3 text-xs transition',
            isRotationDragActive
              ? 'border-blue-400 bg-blue-50 text-blue-700'
              : 'border-slate-300 bg-white text-slate-500 hover:border-blue-300 hover:bg-blue-50/40',
          )}
        >
          <input {...getRotationInput()} />
          <Upload className="h-4 w-4 shrink-0" />
          <span className="flex-1">
            {isRotationDragActive
              ? 'Drop the JSON here…'
              : 'Drop a previously exported JSON to load the roster and pick up the weekend-off rotation where it left off.'}
          </span>
        </div>
        {importInfo && (
          <p className={clsx('text-xs', importInfo.kind === 'ok' ? 'text-emerald-600' : 'text-red-600')}>
            {importInfo.msg}
          </p>
        )}
      </div>

      {/* Date range */}
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium text-slate-600">Schedule starts on</label>
          <input
            type="date"
            value={startDate}
            onChange={(e) => {
              const s = e.target.value
              setDateRange(s, endDate < s ? s : endDate)
            }}
            className="rounded-xl border border-slate-300 bg-white px-4 py-3 text-slate-800 shadow-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-200"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium text-slate-600">Schedule ends on</label>
          <input
            type="date"
            value={endDate}
            min={startDate}
            onChange={(e) => setDateRange(startDate, e.target.value)}
            className="rounded-xl border border-slate-300 bg-white px-4 py-3 text-slate-800 shadow-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-200"
          />
        </div>
      </div>

      {/* Period summary */}
      {isValid && (
        <div className="rounded-xl border border-blue-100 bg-blue-50 px-5 py-4 text-center">
          <div className="grid grid-cols-3 gap-4">
            <div>
              <div className="text-2xl font-bold text-blue-700">{totalDays}</div>
              <div className="text-xs text-blue-500">days</div>
            </div>
            <div>
              <div className="text-2xl font-bold text-blue-700">{totalWeeks}</div>
              <div className="text-xs text-blue-500">week{totalWeeks !== 1 ? 's' : ''}</div>
            </div>
            <div>
              <div className="text-2xl font-bold text-blue-700">≤40h</div>
              <div className="text-xs text-blue-500">per week</div>
            </div>
          </div>
          <p className="mt-3 text-xs text-blue-600">
            {format(parseISO(startDate), 'MMM d, yyyy')} → {format(parseISO(endDate), 'MMM d, yyyy')}
          </p>
          <p className="mt-1 text-xs text-blue-500">
            Mon–Fri: 9 AM – 11 PM · Sat–Sun: 8 AM – 11 PM · work week Thu → Wed
          </p>
        </div>
      )}

      {/* Time-off requests */}
      {isValid && (
        <div className="flex flex-col gap-3">
          <div>
            <h3 className="text-sm font-semibold text-slate-700">Time-off requests</h3>
            <p className="mt-0.5 text-xs text-slate-400">
              Search a dispatcher to mark days off. Dispatchers with existing requests stay in the list.
            </p>
          </div>

          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={`Search ${dispatchers.length} dispatcher${dispatchers.length === 1 ? '' : 's'}…`}
              className="w-full rounded-xl border border-slate-300 bg-white py-2.5 pl-10 pr-9 text-sm text-slate-800 placeholder-slate-400 shadow-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-200"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                aria-label="Clear search"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <div className="text-xs text-slate-400">
            {visibleDispatchers.length === 0
              ? search.trim()
                ? `No dispatchers match "${search}".`
                : 'No time-off requests yet. Use search to find a dispatcher.'
              : `Showing ${visibleDispatchers.length} of ${dispatchers.length} dispatcher${dispatchers.length === 1 ? '' : 's'}.`}
          </div>

          {visibleDispatchers.map((d) => {
            const dispatcherTimeOff = timeOff[d.id] ?? {}
            const fullDays = allDates.filter(({ date }) => {
              const bm = dispatcherTimeOff[date]
              return bm && bm.length === SLOTS.length && bm.every(Boolean)
            }).length
            const partialDays = allDates.filter(({ date }) => {
              const bm = dispatcherTimeOff[date]
              return bm && bm.some(Boolean) && !bm.every(Boolean)
            }).length
            const isOpen = expanded.has(d.id)
            return (
              <div key={d.id} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                <div className="mb-3 flex items-center gap-2">
                  <div
                    className="flex h-7 w-7 items-center justify-center rounded-full text-[11px] font-bold text-white"
                    style={{ backgroundColor: d.color }}
                  >
                    {d.name.split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase()}
                  </div>
                  <span className="text-sm font-medium text-slate-800">{d.name}</span>
                  <div className="ml-auto flex items-center gap-1.5">
                    {fullDays > 0 && (
                      <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-600">
                        {fullDays} full day{fullDays !== 1 ? 's' : ''} off
                      </span>
                    )}
                    {partialDays > 0 && (
                      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">
                        {partialDays} partial
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => setAbsenceFormOpen((prev) => {
                        const next = new Set(prev)
                        if (next.has(d.id)) next.delete(d.id)
                        else next.add(d.id)
                        return next
                      })}
                      className="flex items-center gap-1 rounded-md border border-blue-200 bg-blue-50 px-2 py-0.5 text-[11px] font-semibold text-blue-700 transition hover:bg-blue-100"
                    >
                      <CalendarPlus className="h-3 w-3" />
                      Absence
                    </button>
                  </div>
                </div>
                {absenceFormOpen.has(d.id) && (
                  <div className="mb-2">
                    <AbsenceRangeForm
                      minDate={startDate}
                      maxDate={endDate}
                      slots={SLOTS}
                      onApply={(start, end, reason, slotMask) => {
                        applyAbsenceRange(d.id, start, end, reason, slotMask)
                        setAbsenceFormOpen((prev) => {
                          const next = new Set(prev)
                          next.delete(d.id)
                          return next
                        })
                      }}
                      onCancel={() => setAbsenceFormOpen((prev) => {
                        const next = new Set(prev)
                        next.delete(d.id)
                        return next
                      })}
                    />
                  </div>
                )}
                <div className="flex flex-col gap-1.5">
                  {allDates.map(({ date, label }) => {
                    const bm = dispatcherTimeOff[date]
                    const fullOff = !!bm && bm.length === SLOTS.length && bm.every(Boolean)
                    const partial = !!bm && bm.some(Boolean) && !fullOff
                    const blockedCount = bm?.reduce((acc, on, i) => acc + (on ? SLOTS[i].hours : 0), 0) ?? 0
                    const dateOpen = isOpen && expanded.has(`${d.id}:${date}`)
                    const reason = absenceReasons[d.id]?.[date]
                    const reasonCls = reason ? reasonColors(reason).tw : null
                    return (
                      <div key={date} className="flex flex-col gap-1">
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => toggleFullDayOff(d.id, date)}
                            className={clsx(
                              'flex-1 rounded-lg border px-2.5 py-1.5 text-left text-xs font-medium transition flex items-center gap-2',
                              fullOff && !reason && 'border-red-300 bg-red-50 text-red-700',
                              partial && 'border-amber-300 bg-amber-50 text-amber-700',
                              !fullOff && !partial && 'border-slate-200 bg-slate-50 text-slate-600 hover:border-blue-300 hover:bg-blue-50',
                              fullOff && reasonCls,
                            )}
                          >
                            <span>{label}</span>
                            {reason && (
                              <HoverHint label={reasonLabel(reason)} side="bottom">
                                <span className="rounded border border-current/30 bg-white/40 px-1 py-0.5 text-[9px] font-bold uppercase tracking-wide">
                                  {reasonShort(reason)}
                                </span>
                              </HoverHint>
                            )}
                            {partial && (
                              <span className="ml-auto text-[10px] opacity-70">{blockedCount}h blocked</span>
                            )}
                          </button>
                          <button
                            type="button"
                            onClick={() => setExpanded((prev) => {
                              const next = new Set(prev)
                              const key = `${d.id}:${date}`
                              if (next.has(key)) next.delete(key)
                              else { next.add(key); next.add(d.id) }
                              return next
                            })}
                            className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                            aria-label="Block specific hours"
                          >
                            {dateOpen
                              ? <ChevronDown className="h-3.5 w-3.5" />
                              : <ChevronRight className="h-3.5 w-3.5" />}
                          </button>
                        </div>
                        {dateOpen && (
                          <div className="flex flex-wrap gap-1 rounded-lg bg-slate-50 p-2">
                            {SLOTS.map((slot, si) => {
                              const blocked = bm?.[si] ?? false
                              return (
                                <button
                                  key={si}
                                  type="button"
                                  onClick={() => toggleBlockedSlot(d.id, date, si)}
                                  className={clsx(
                                    'rounded border px-1.5 py-0.5 text-[10px] font-medium transition',
                                    blocked
                                      ? 'border-red-300 bg-red-100 text-red-700'
                                      : 'border-slate-200 bg-white text-slate-500 hover:border-red-200 hover:bg-red-50',
                                  )}
                                  title={blocked ? `Unblock ${slot.label}` : `Block ${slot.label}`}
                                >
                                  {shortHour(slot.label)}
                                </button>
                              )
                            })}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
                <button
                  type="button"
                  onClick={() => toggleExpand(d.id)}
                  className="mt-2 text-[11px] text-slate-400 hover:text-blue-600"
                >
                  {isOpen ? 'Hide hour pickers' : 'Show hour pickers'}
                </button>
              </div>
            )
          })}
        </div>
      )}

      {/* Actions */}
      <div className="flex justify-between pt-2">
        <button
          onClick={() => setStep('names')}
          className="rounded-xl border border-slate-300 px-5 py-3 text-sm font-medium text-slate-600 transition hover:bg-slate-50"
        >
          ← Back
        </button>
        <button
          disabled={!isValid}
          onClick={handleGenerate}
          className="rounded-xl bg-blue-600 px-8 py-3 text-sm font-semibold text-white shadow transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Generate Schedule →
        </button>
      </div>
    </div>
  )
}
