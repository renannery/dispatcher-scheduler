import clsx from 'clsx'
import { ChevronDown, ChevronRight, Download, FileJson, FileText, Loader2, RefreshCw, Search, Shield, Users, X } from 'lucide-react'
import { parseISO } from 'date-fns'
import { useEffect, useMemo, useRef, useState } from 'react'

import { DAY_TEMPLATES } from '@/data/coverageTemplate'
import { useSchedulerStore } from '@/store/schedulerStore'
import { generateSchedule, HEAVY_DAYS, hoursStatusBg, hoursStatusColor, weekendOffDispatcherId } from '@/utils/scheduler'
import { downloadSnapshot, SCHEMA_VERSION } from '@/utils/snapshot'
import { exportScheduleToXLS } from '@/utils/xlsExporter'
import { DayGrid } from './DayGrid'

// ---------------------------------------------------------------------------
// PDF dropdown
// ---------------------------------------------------------------------------

type PdfAction =
  | { type: 'admin' }
  | { type: 'team' }
  | { type: 'individual'; dispatcherId: string; name: string }

interface PdfMenuProps {
  dispatchers: { id: string; name: string; color: string }[]
  loading: boolean
  onSelect: (action: PdfAction) => void
}

function PdfMenu({ dispatchers, loading, onSelect }: PdfMenuProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const pick = (action: PdfAction) => {
    setOpen(false)
    onSelect(action)
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={loading}
        className="flex items-center gap-2 rounded-xl border border-violet-300 bg-violet-50 px-4 py-2 text-sm font-semibold text-violet-700 shadow-sm transition hover:bg-violet-100 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
        {loading ? 'Generating…' : 'PDF'}
        {!loading && <ChevronDown className="h-3.5 w-3.5 opacity-60" />}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-30 mt-1.5 w-56 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg">
          {/* Admin */}
          <button
            onClick={() => pick({ type: 'admin' })}
            className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm transition hover:bg-slate-50"
          >
            <Shield className="h-4 w-4 text-blue-600 shrink-0" />
            <div>
              <div className="font-semibold text-slate-800">Admin</div>
              <div className="text-xs text-slate-400">All dispatchers + hours</div>
            </div>
          </button>

          {/* Team */}
          <button
            onClick={() => pick({ type: 'team' })}
            className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm transition hover:bg-slate-50"
          >
            <Users className="h-4 w-4 text-emerald-600 shrink-0" />
            <div>
              <div className="font-semibold text-slate-800">Team</div>
              <div className="text-xs text-slate-400">All dispatchers, no hours</div>
            </div>
          </button>

          {/* Individual divider */}
          <div className="mx-4 border-t border-slate-100 my-1" />
          <div className="px-4 py-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
            Individual
          </div>

          {dispatchers.map((d) => (
            <button
              key={d.id}
              onClick={() => pick({ type: 'individual', dispatcherId: d.id, name: d.name })}
              className="flex w-full items-center gap-3 px-4 py-2 text-left text-sm transition hover:bg-slate-50"
            >
              <div
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[9px] font-bold text-white"
                style={{ backgroundColor: d.color }}
              >
                {d.name.split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase()}
              </div>
              <span className="text-slate-700">{d.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function ScheduleGrid() {
  const { schedule, dispatchers, startDate, endDate, timeOff, absenceReasons, weekendRotationOffset, setSchedule, setStep } =
    useSchedulerStore()
  const [expandedDates, setExpandedDates] = useState<Set<string>>(new Set())
  const [pdfLoading, setPdfLoading] = useState(false)
  const [showAllPills, setShowAllPills] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')

  const trimmedSearch = search.trim().toLowerCase()
  const matchedDispatcherIds = useMemo(() => {
    if (!trimmedSearch) return null
    const ids = new Set<string>()
    for (const d of dispatchers) {
      if (d.name.toLowerCase().includes(trimmedSearch)) ids.add(d.id)
    }
    return ids
  }, [dispatchers, trimmedSearch])

  if (!schedule) return null

  const weekLabels = [...new Set(schedule.dates.map((d) => d.weekLabel))]

  const toggleDay = (date: string) => {
    setExpandedDates((prev) => {
      const next = new Set(prev)
      if (next.has(date)) next.delete(date)
      else next.add(date)
      return next
    })
  }

  const expandAll  = () => setExpandedDates(new Set(schedule.dates.map((d) => d.date)))
  const collapseAll = () => setExpandedDates(new Set())

  // Local bump for variety on each Regenerate click. Added on top of the
  // persisted rotation cursor; doesn't advance the persisted cursor itself.
  const regenSeed = useRef(0)
  const handleRegenerate = () => {
    regenSeed.current++
    const fresh = generateSchedule(dispatchers, startDate, endDate, timeOff, weekendRotationOffset + regenSeed.current)
    setSchedule(fresh)
    setExpandedDates(new Set())
  }

  const handleExportJson = () => {
    downloadSnapshot({
      version: SCHEMA_VERSION,
      team: 'dispatchers',
      exportedAt: new Date().toISOString(),
      data: { dispatchers, startDate, endDate, timeOff, absenceReasons, weekendRotationOffset, schedule },
    })
  }

  const handlePdfSelect = async (action: PdfAction) => {
    setPdfLoading(true)
    try {
      const mod = await import('@/utils/pdfExporter')
      if (action.type === 'admin')      await mod.exportAdminPDF(schedule)
      if (action.type === 'team')       await mod.exportTeamPDF(schedule)
      if (action.type === 'individual') await mod.exportIndividualPDF(schedule, action.dispatcherId)
    } finally {
      setPdfLoading(false)
    }
  }

  // Peak weekly hours per dispatcher for the action bar
  const totalsByPerson = schedule.dispatcherSchedules.map((ds) => ({
    name:  ds.dispatcher.name,
    color: ds.dispatcher.color,
    level: ds.dispatcher.level,
    hours: Math.max(0, ...Object.values(ds.weeklyHours)),
  }))

  return (
    <div className="flex flex-col gap-6">
      {/* Action bar */}
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-slate-200 bg-white px-5 py-4 shadow-sm">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-xs font-medium text-slate-400 uppercase tracking-wide">peak wk</span>
          {totalsByPerson.map(({ name, hours, color, level }) => (
            <div key={name} className="flex items-center gap-1.5 text-sm" title={`${name}: ${hours.toFixed(1)}h peak week`}>
              <div className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: color }} />
              <span className="font-medium text-slate-700">{name.split(' ')[0]}</span>
              <span className={clsx(
                'rounded px-1.5 py-0 text-[10px] font-bold',
                level === 'Senior'  && 'bg-amber-100 text-amber-600',
                level === 'Regular' && 'bg-blue-100 text-blue-600',
                level === 'Trainee' && 'bg-slate-100 text-slate-500',
              )}>
                {level === 'Senior' ? 'SR' : level === 'Regular' ? 'RG' : 'TR'}
              </span>
              <span className={clsx('font-bold', hoursStatusColor(hours))}>{hours.toFixed(1)}h</span>
            </div>
          ))}
        </div>
        <div className="flex gap-2">
          <button
            onClick={handleRegenerate}
            className="flex items-center gap-2 rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
          >
            <RefreshCw className="h-4 w-4" />
            Regenerate
          </button>
          <button
            onClick={handleExportJson}
            title="Save the full schedule state so you can reload it later"
            className="flex items-center gap-2 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
          >
            <FileJson className="h-4 w-4" />
            JSON
          </button>
          <PdfMenu
            dispatchers={dispatchers}
            loading={pdfLoading}
            onSelect={handlePdfSelect}
          />
          <button
            onClick={() => exportScheduleToXLS(schedule)}
            className="flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow transition hover:bg-blue-700"
          >
            <Download className="h-4 w-4" />
            XLS
          </button>
        </div>
      </div>

      {/* Dispatcher search — filters pill list and day-grid rows */}
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={`Search ${dispatchers.length} dispatcher${dispatchers.length === 1 ? '' : 's'} — filters hour pills and grid rows…`}
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

      {/* Per-week sections */}
      {weekLabels.map((wl) => {
        const weekDates = schedule.dates.filter((d) => d.weekLabel === wl)

        const heavyDateInfo = weekDates.find((d) => HEAVY_DAYS.has(d.dayOfWeek))
        const weekendOffId = heavyDateInfo
          ? weekendOffDispatcherId(parseISO(heavyDateInfo.date), parseISO(schedule.startDate), dispatchers, schedule.seed)
          : null
        const weekendOffDispatcher = weekendOffId
          ? schedule.dispatcherSchedules.find((ds) => ds.dispatcher.id === weekendOffId)?.dispatcher
          : null

        const weekHoursSummary = schedule.dispatcherSchedules.map((ds) => ({
          name:  ds.dispatcher.name,
          hours: ds.weeklyHours[wl] ?? 0,
        }))

        // Aggregate summary
        const allHours = weekHoursSummary.map((s) => s.hours)
        const atCap = allHours.filter((h) => h >= 40).length
        const under = allHours.filter((h) => h > 0 && h < 36).length
        const target = allHours.filter((h) => h >= 36 && h < 40).length
        const offCount = allHours.filter((h) => h === 0).length

        const filteredPills = trimmedSearch
          ? weekHoursSummary.filter(({ name }) => name.toLowerCase().includes(trimmedSearch))
          : weekHoursSummary
        const pillsExpanded = showAllPills.has(wl) || !!trimmedSearch

        return (
          <div key={wl} className="rounded-2xl border border-slate-200 bg-white shadow-sm">
            {/* Week header */}
            <div className="flex flex-col gap-2 border-b border-slate-100 px-5 py-3">
              <div className="flex items-center justify-between gap-4">
                <div className="flex flex-wrap items-center gap-3">
                  <h3 className="font-semibold text-slate-800">{wl}</h3>
                  <div className="text-xs text-slate-500">
                    <span className="font-semibold text-emerald-600">{atCap}</span> at 40h ·
                    <span className="ml-1 font-semibold text-emerald-600">{target}</span> 36–39h ·
                    <span className="ml-1 font-semibold text-amber-600">{under}</span> under
                    {offCount > 0 && (
                      <><span className="ml-1">·</span> <span className="ml-1 font-semibold text-slate-500">{offCount}</span> off</>
                    )}
                  </div>
                  {weekendOffDispatcher && (
                    <span
                      className="flex items-center gap-1 rounded-full border border-violet-200 bg-violet-50 px-2.5 py-0.5 text-xs font-medium text-violet-700"
                      title={`${weekendOffDispatcher.name} has Fri/Sat/Sun off this 2-week block`}
                    >
                      <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: weekendOffDispatcher.color }} />
                      {weekendOffDispatcher.name.split(' ')[0]}: weekend off
                    </span>
                  )}
                </div>
                <div className="flex shrink-0 gap-2 text-xs text-slate-400">
                  <button
                    onClick={() => setShowAllPills((prev) => {
                      const next = new Set(prev)
                      if (next.has(wl)) next.delete(wl)
                      else next.add(wl)
                      return next
                    })}
                    className="hover:text-blue-600"
                  >
                    {pillsExpanded ? 'hide hours' : 'show hours'}
                  </button>
                  <span>·</span>
                  <button onClick={expandAll}  className="hover:text-blue-600">expand all</button>
                  <span>·</span>
                  <button onClick={collapseAll} className="hover:text-blue-600">collapse</button>
                </div>
              </div>
              {pillsExpanded && (
                <div className="flex flex-wrap gap-1.5">
                  {filteredPills.length === 0 && (
                    <span className="text-xs text-slate-400">No dispatchers match &quot;{trimmedSearch}&quot;.</span>
                  )}
                  {filteredPills.map(({ name, hours }) => (
                    <span
                      key={name}
                      className={clsx('rounded-full border px-2 py-0.5 text-xs font-semibold', hoursStatusBg(hours))}
                    >
                      {name.split(' ')[0]} {hours.toFixed(1)}h
                    </span>
                  ))}
                </div>
              )}
            </div>

            {/* Per-day rows */}
            {weekDates.map((dateInfo) => {
              const isExpanded = expandedDates.has(dateInfo.date)
              const working = schedule.dispatcherSchedules.filter(
                (ds) => !ds.days.find((d) => d.date === dateInfo.date)?.isOff,
              ).length
              const off     = schedule.dispatcherSchedules.length - working
              const actual   = schedule.coverageActual[dateInfo.date] ?? []
              const required = DAY_TEMPLATES[dateInfo.dayOfWeek]?.requiredCoverage ?? []
              const hasGap   = required.some((r, i) => (actual[i] ?? 0) < r)

              return (
                <div key={dateInfo.date} className="border-t border-slate-100 first:border-0">
                  <button
                    onClick={() => toggleDay(dateInfo.date)}
                    className="flex w-full items-center gap-3 px-5 py-3 text-left hover:bg-slate-50"
                  >
                    <span className="text-slate-400">
                      {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                    </span>
                    <span className="min-w-[140px] text-sm font-semibold text-slate-800">{dateInfo.dayLabel}</span>
                    <span className="text-xs text-slate-500">{working} working · {off} off</span>
                    {hasGap && (
                      <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-600">
                        ⚠ coverage gap
                      </span>
                    )}
                  </button>

                  {isExpanded && (
                    <div className="border-t border-slate-100 bg-slate-50/30">
                      <DayGrid
                        schedule={schedule}
                        date={dateInfo.date}
                        dayLabel={dateInfo.dayLabel}
                        dayOfWeek={dateInfo.dayOfWeek}
                        dispatcherIdFilter={matchedDispatcherIds}
                      />
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )
      })}

      {/* Bottom actions */}
      <div className="flex items-center justify-between pt-2">
        <button
          onClick={() => setStep('period')}
          className="rounded-xl border border-slate-300 px-5 py-2.5 text-sm font-medium text-slate-600 transition hover:bg-slate-50"
        >
          ← Back
        </button>
        <div className="flex gap-2">
          <button
            onClick={handleExportJson}
            title="Save the full schedule state so you can reload it later"
            className="flex items-center gap-2 rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
          >
            <FileJson className="h-4 w-4" />
            JSON
          </button>
          <PdfMenu
            dispatchers={dispatchers}
            loading={pdfLoading}
            onSelect={handlePdfSelect}
          />
          <button
            onClick={() => exportScheduleToXLS(schedule)}
            className="flex items-center gap-2 rounded-xl bg-blue-600 px-6 py-2.5 text-sm font-semibold text-white shadow transition hover:bg-blue-700"
          >
            <Download className="h-4 w-4" />
            Download XLS
          </button>
        </div>
      </div>
    </div>
  )
}
