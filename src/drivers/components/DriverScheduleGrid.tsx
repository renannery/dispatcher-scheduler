import clsx from 'clsx'
import { AlertTriangle, ChevronDown, ChevronRight, Download, FileJson, FileText, Loader2, RefreshCw, Search, Shield, UserPlus, Users, X } from 'lucide-react'
import { parseISO } from 'date-fns'
import { useEffect, useMemo, useRef, useState } from 'react'

import { downloadSnapshot, SCHEMA_VERSION } from '@/utils/snapshot'

import { effectiveCoverage } from '../coverageTemplate'
import { analyzeCoverageHealth, COVERAGE_GAP_TOLERANCE, generateDriverSchedule, HEAVY_DAYS, hoursStatusBg, weekendOffDriverId } from '../scheduler'
import { useDriverStore } from '../store'
import { displayName } from '../utils'
import { exportDriverScheduleToXLS } from '../xlsExporter'
import { DriverDayGrid } from './DriverDayGrid'

type PdfAction =
  | { type: 'admin' }
  | { type: 'team' }
  | { type: 'individual'; driverId: string; name: string }

interface PdfMenuProps {
  drivers: { id: string; name: string; color: string }[]
  loading: boolean
  onSelect: (action: PdfAction) => void
}

function PdfMenu({ drivers, loading, onSelect }: PdfMenuProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

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
        <div className="absolute right-0 top-full z-30 mt-1.5 max-h-[60vh] w-56 overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-lg">
          <button
            onClick={() => pick({ type: 'admin' })}
            className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm transition hover:bg-slate-50"
          >
            <Shield className="h-4 w-4 shrink-0 text-blue-600" />
            <div>
              <div className="font-semibold text-slate-800">Admin</div>
              <div className="text-xs text-slate-400">All drivers + hours</div>
            </div>
          </button>

          <button
            onClick={() => pick({ type: 'team' })}
            className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm transition hover:bg-slate-50"
          >
            <Users className="h-4 w-4 shrink-0 text-emerald-600" />
            <div>
              <div className="font-semibold text-slate-800">Team</div>
              <div className="text-xs text-slate-400">All drivers, no hours</div>
            </div>
          </button>

          <div className="mx-4 my-1 border-t border-slate-100" />
          <div className="px-4 py-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
            Individual
          </div>

          {drivers.map((d) => (
            <button
              key={d.id}
              onClick={() => pick({ type: 'individual', driverId: d.id, name: d.name })}
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

export function DriverScheduleGrid() {
  const {
    schedule,
    drivers,
    startDate,
    endDate,
    timeOff,
    absenceReasons,
    fullTimeCap,
    partTimeCap,
    coverageScale,
    coverageOverrides,
    minHoursPerDay,
    maxHoursPerDay,
    weekendRotationOffset,
    setSchedule,
    setStep,
  } = useDriverStore()
  const [expandedDates, setExpandedDates] = useState<Set<string>>(new Set())
  const [pdfLoading, setPdfLoading] = useState(false)
  const [showAllPills, setShowAllPills] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')

  const trimmedSearch = search.trim().toLowerCase()
  const matchedDriverIds = useMemo(() => {
    if (!trimmedSearch) return null
    const ids = new Set<string>()
    for (const d of drivers) {
      if (d.name.toLowerCase().includes(trimmedSearch)) ids.add(d.id)
    }
    return ids
  }, [drivers, trimmedSearch])

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

  const expandAll = () => setExpandedDates(new Set(schedule.dates.map((d) => d.date)))
  const collapseAll = () => setExpandedDates(new Set())

  // Local bump for variety on each Regenerate click — added on top of the
  // persisted rotation cursor. Doesn't advance the persisted cursor (that
  // only moves when the user generates from the period step).
  const regenSeed = useRef(0)
  const handleRegenerate = () => {
    regenSeed.current++
    const fresh = generateDriverSchedule({
      drivers, startDate, endDate, timeOff, fullTimeCap, partTimeCap, coverageScale, coverageOverrides,
      minHoursPerDay, maxHoursPerDay,
      seed: weekendRotationOffset + regenSeed.current,
    })
    setSchedule(fresh)
    setExpandedDates(new Set())
  }

  const handleExportJson = () => {
    downloadSnapshot({
      version: SCHEMA_VERSION,
      team: 'drivers',
      exportedAt: new Date().toISOString(),
      data: {
        drivers, startDate, endDate, fullTimeCap, partTimeCap, coverageScale, coverageOverrides,
        minHoursPerDay, maxHoursPerDay, timeOff, absenceReasons, weekendRotationOffset, schedule,
      },
    })
  }

  const handlePdfSelect = async (action: PdfAction) => {
    setPdfLoading(true)
    try {
      const mod = await import('../pdfExporter')
      if (action.type === 'admin')      await mod.exportDriverAdminPDF(schedule)
      if (action.type === 'team')       await mod.exportDriverTeamPDF(schedule)
      if (action.type === 'individual') await mod.exportDriverIndividualPDF(schedule, action.driverId)
    } finally {
      setPdfLoading(false)
    }
  }

  const health = analyzeCoverageHealth(schedule, coverageScale, coverageOverrides)

  return (
    <div className="flex flex-col gap-6">
      {health.weeklyShortfallHours >= 20 && (
        <div className="flex items-start gap-3 rounded-2xl border border-amber-300 bg-amber-50 px-5 py-4 shadow-sm">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
          <div className="flex-1 text-sm text-amber-900">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-semibold">
                Roster is {Math.round(health.weeklyShortfallHours)} driver-hours short per week.
              </span>
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold">
                <UserPlus className="h-3 w-3" />
                Hire {health.recommendedAdditionalDrivers} more full-time driver
                {health.recommendedAdditionalDrivers === 1 ? '' : 's'}
              </span>
            </div>
            <p className="mt-1 text-xs text-amber-800/80">
              Assumes each new full-timer realistically contributes ~35h/week after night-rest, weekend rotation, and time-off.
              {health.worstDays.length > 0 && ' Worst gaps: '}
              {health.worstDays.map((d, i) => (
                <span key={d.date}>
                  {i > 0 && ', '}
                  <span className="font-semibold">{d.dayLabel}</span> ({Math.round(d.shortfall)}h short)
                </span>
              ))}
              .
              {' '}Or drop the coverage scale on the Period step to relax targets.
            </p>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-slate-200 bg-white px-5 py-4 shadow-sm">
        <div className="text-sm text-slate-500">
          <span className="font-semibold text-slate-700">{drivers.length}</span> drivers ·
          <span className="ml-1 font-semibold text-slate-700">{schedule.dates.length}</span> days ·
          full-time cap <span className="font-semibold text-slate-700">{fullTimeCap}h</span> ·
          part-time cap <span className="font-semibold text-slate-700">{schedule.partTimeCap}h</span>
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
          <PdfMenu drivers={drivers} loading={pdfLoading} onSelect={handlePdfSelect} />
          <button
            onClick={() => exportDriverScheduleToXLS(schedule)}
            className="flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow transition hover:bg-blue-700"
          >
            <Download className="h-4 w-4" />
            XLS
          </button>
        </div>
      </div>

      {/* Driver search — filters pill list and day-grid rows */}
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={`Search ${drivers.length} driver${drivers.length === 1 ? '' : 's'} — filters hour pills and grid rows…`}
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

      {weekLabels.map((wl) => {
        const weekDates = schedule.dates.filter((d) => d.weekLabel === wl)

        const heavyDateInfo = weekDates.find((d) => HEAVY_DAYS.has(d.dayOfWeek))
        const weekendOffId = heavyDateInfo
          ? weekendOffDriverId(parseISO(heavyDateInfo.date), parseISO(schedule.startDate), drivers, schedule.seed)
          : null
        const weekendOffDriver = weekendOffId
          ? schedule.driverSchedules.find((ds) => ds.driver.id === weekendOffId)?.driver
          : null

        const weekHoursSummary = schedule.driverSchedules.map((ds) => ({
          name:  ds.driver.name,
          type:  ds.driver.employmentType,
          hours: ds.weeklyHours[wl] ?? 0,
        }))

        // Aggregate the per-driver hours into a quick summary
        const ftSummary = schedule.driverSchedules
          .filter((ds) => ds.driver.employmentType === 'full')
          .map((ds) => ds.weeklyHours[wl] ?? 0)
        const ptSummary = schedule.driverSchedules
          .filter((ds) => ds.driver.employmentType === 'part')
          .map((ds) => ds.weeklyHours[wl] ?? 0)
        const ftAtCap = ftSummary.filter((h) => h >= fullTimeCap).length
        const ftUnder = ftSummary.filter((h) => h > 0 && h < fullTimeCap).length
        const ftOff = ftSummary.filter((h) => h === 0).length
        const ptAtCap = ptSummary.filter((h) => h >= schedule.partTimeCap).length
        const ptUnder = ptSummary.filter((h) => h > 0 && h < schedule.partTimeCap).length

        // Filter pills by the active search query (if any)
        const filteredPills = trimmedSearch
          ? weekHoursSummary.filter(({ name }) => name.toLowerCase().includes(trimmedSearch))
          : weekHoursSummary
        const pillsExpanded = showAllPills.has(wl) || !!trimmedSearch

        return (
          <div key={wl} className="rounded-2xl border border-slate-200 bg-white shadow-sm">
            <div className="flex flex-col gap-2 border-b border-slate-100 px-5 py-3">
              <div className="flex items-center justify-between gap-4">
                <div className="flex flex-wrap items-center gap-3">
                  <h3 className="font-semibold text-slate-800">{wl}</h3>
                  <div className="text-xs text-slate-500">
                    <span className="font-semibold text-emerald-600">{ftAtCap}</span> at cap ·
                    <span className="ml-1 font-semibold text-amber-600">{ftUnder}</span> under ·
                    {ftOff > 0 && (
                      <><span className="ml-1 font-semibold text-slate-500">{ftOff}</span> off ·</>
                    )}
                    <span className="ml-1 font-semibold text-blue-600">{ptAtCap + ptUnder}</span> PT
                  </div>
                  {weekendOffDriver && (
                    <span
                      className="flex items-center gap-1 rounded-full border border-violet-200 bg-violet-50 px-2.5 py-0.5 text-xs font-medium text-violet-700"
                      title={`${weekendOffDriver.name} has Fri/Sat/Sun off this 2-week block`}
                    >
                      <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: weekendOffDriver.color }} />
                      {displayName(weekendOffDriver.name)}: weekend off
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
                  <button onClick={expandAll} className="hover:text-blue-600">expand all</button>
                  <span>·</span>
                  <button onClick={collapseAll} className="hover:text-blue-600">collapse</button>
                </div>
              </div>
              {pillsExpanded && (
                <div className="flex flex-wrap gap-1.5">
                  {filteredPills.length === 0 && (
                    <span className="text-xs text-slate-400">No drivers match &quot;{trimmedSearch}&quot;.</span>
                  )}
                  {filteredPills.map(({ name, type, hours }) => {
                    const cap = type === 'full' ? fullTimeCap : schedule.partTimeCap
                    return (
                      <span
                        key={name}
                        className={clsx(
                          'rounded-full border px-2 py-0.5 text-xs font-semibold',
                          hoursStatusBg(hours, cap),
                        )}
                        title={`${name}: ${hours}h / ${cap}h cap`}
                      >
                        {displayName(name)} {hours}h
                      </span>
                    )
                  })}
                </div>
              )}
            </div>

            {weekDates.map((dateInfo) => {
              const isExpanded = expandedDates.has(dateInfo.date)
              const working = schedule.driverSchedules.filter(
                (ds) => !ds.days.find((d) => d.date === dateInfo.date)?.isOff,
              ).length
              const off = schedule.driverSchedules.length - working
              const actual = schedule.coverageActual[dateInfo.date] ?? []
              // Use the EFFECTIVE coverage (scale + overrides). The count
              // matches the per-slot red badges in the day grid: any slot
              // short by at least 1 counts as a gap. Severe gaps (more than
              // COVERAGE_GAP_TOLERANCE short) get an extra emphasis tag so
              // the user can tell "barely off" from "operationally short".
              const required = effectiveCoverage(dateInfo.dayOfWeek, coverageScale, coverageOverrides)
              let gapSlots = 0
              let severeGaps = 0
              for (let i = 0; i < required.length; i++) {
                const diff = required[i] - (actual[i] ?? 0)
                if (diff > 0) gapSlots++
                if (diff > COVERAGE_GAP_TOLERANCE) severeGaps++
              }

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
                    {gapSlots > 0 && (
                      <span
                        className={clsx(
                          'rounded-full px-2 py-0.5 text-xs font-medium',
                          severeGaps > 0
                            ? 'bg-red-100 text-red-700'
                            : 'bg-amber-100 text-amber-700',
                        )}
                        title={
                          severeGaps > 0
                            ? `${gapSlots} of ${required.length} hourly slot${gapSlots === 1 ? '' : 's'} short — ${severeGaps} severely (more than ${COVERAGE_GAP_TOLERANCE} drivers under)`
                            : `${gapSlots} of ${required.length} hourly slot${gapSlots === 1 ? '' : 's'} short — all within ±${COVERAGE_GAP_TOLERANCE} ops tolerance`
                        }
                      >
                        ⚠ {gapSlots} coverage gap{gapSlots === 1 ? '' : 's'}
                        {severeGaps > 0 && ` (${severeGaps} severe)`}
                      </span>
                    )}
                  </button>

                  {isExpanded && (
                    <div className="border-t border-slate-100 bg-slate-50/30">
                      <DriverDayGrid
                        schedule={schedule}
                        date={dateInfo.date}
                        dayLabel={dateInfo.dayLabel}
                        dayOfWeek={dateInfo.dayOfWeek}
                        driverIdFilter={matchedDriverIds}
                      />
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )
      })}

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
          <PdfMenu drivers={drivers} loading={pdfLoading} onSelect={handlePdfSelect} />
          <button
            onClick={() => exportDriverScheduleToXLS(schedule)}
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
