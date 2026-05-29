import clsx from 'clsx'
import { AlertTriangle, ChevronDown, ChevronRight, Download, FileJson, FileText, Lightbulb, Loader2, Plus, RefreshCw, Search, Shield, UserPlus, Users, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { downloadSnapshot, SCHEMA_VERSION } from '@/utils/snapshot'
import { HoverHint } from '@/components/HoverHint'

import { effectiveCoverage, LEGAL_DAILY_MAX_HOURS, LEGAL_WEEKLY_MAX_HOURS } from '../coverageTemplate'
import { analyzeCoverageHealth, generateDriverSchedule, hoursStatusBg } from '../scheduler'
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

// ─── Suggestions banner ─────────────────────────────────────────────────────
//
// Shown at the top of the schedule step when there's any weekly shortfall.
// Lets ops bump the FT cap, daily max, or coverage scale right here and
// regenerate, instead of having to walk back to the Period step.

interface SuggestionsBannerProps {
  shortfallHours: number
  fullTimeCap: number
  maxHoursPerDay: number
  coverageScale: number
  onApply: (next: { fullTimeCap: number; maxHoursPerDay: number; coverageScale: number }) => void
}

function SuggestionsBanner({ shortfallHours, fullTimeCap, maxHoursPerDay, coverageScale, onApply }: SuggestionsBannerProps) {
  // Pending edits — the user dials these before applying.
  const [cap, setCap] = useState(fullTimeCap)
  const [maxH, setMaxH] = useState(maxHoursPerDay)
  const [scale, setScale] = useState(coverageScale)
  const dirty = cap !== fullTimeCap || maxH !== maxHoursPerDay || scale !== coverageScale

  // Reset pending values when the underlying store changes (e.g. user
  // navigates back to Period step and saves) so we don't show stale.
  useEffect(() => { setCap(fullTimeCap) }, [fullTimeCap])
  useEffect(() => { setMaxH(maxHoursPerDay) }, [maxHoursPerDay])
  useEffect(() => { setScale(coverageScale) }, [coverageScale])

  return (
    <div className="rounded-2xl border border-blue-300 bg-blue-50 px-5 py-4 shadow-sm">
      <div className="flex items-start gap-3">
        <Lightbulb className="mt-0.5 h-5 w-5 shrink-0 text-blue-600" />
        <div className="flex-1">
          <div className="text-sm font-semibold text-blue-900">
            Coverage is {Math.round(shortfallHours)} driver-hours short per week. Try one of these:
          </div>
          <p className="mt-1 text-xs text-blue-800/80">
            Bump a knob, then click <span className="font-semibold">Apply &amp; regenerate</span>.
            You can also{' '}
            <button
              type="button"
              onClick={() => useDriverStore.getState().setStep('period')}
              className="underline underline-offset-2 hover:text-blue-900"
            >
              go back to the Period step
            </button>
            {' '}for more controls.
          </p>

          <div className="mt-3 flex flex-wrap items-end gap-3">
            <Knob
              label="Weekly cap"
              suffix="h"
              value={cap}
              setValue={setCap}
              min={20}
              max={60}
              hint={cap > fullTimeCap ? `+${cap - fullTimeCap} h/wk` : cap < fullTimeCap ? `−${fullTimeCap - cap} h/wk` : null}
            />
            <Knob
              label="Daily max"
              suffix="h"
              value={maxH}
              setValue={setMaxH}
              min={4}
              max={11}
              hint={maxH > maxHoursPerDay ? `+${maxH - maxHoursPerDay} h/day` : maxH < maxHoursPerDay ? `−${maxHoursPerDay - maxH} h/day` : null}
            />
            <Knob
              label="Coverage scale"
              suffix=""
              value={scale}
              setValue={setScale}
              min={0.5}
              max={1.5}
              step={0.05}
              format={(v) => v.toFixed(2)}
              hint={scale !== coverageScale ? `${Math.round((scale - coverageScale) * 100)}%` : null}
            />
            <button
              type="button"
              disabled={!dirty}
              onClick={() => onApply({ fullTimeCap: cap, maxHoursPerDay: maxH, coverageScale: scale })}
              className={clsx(
                'flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold shadow-sm transition',
                dirty
                  ? 'bg-blue-600 text-white hover:bg-blue-700'
                  : 'cursor-not-allowed bg-slate-200 text-slate-400',
              )}
            >
              <RefreshCw className="h-4 w-4" />
              Apply &amp; regenerate
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

interface KnobProps {
  label: string
  suffix: string
  value: number
  setValue: (v: number) => void
  min: number
  max: number
  step?: number
  format?: (v: number) => string
  hint?: string | null
}
function Knob({ label, suffix, value, setValue, min, max, step = 1, format, hint }: KnobProps) {
  return (
    <div className="flex flex-col">
      <label className="text-[10px] font-semibold uppercase tracking-wide text-blue-700/70">{label}</label>
      <div className="mt-0.5 flex items-center gap-1">
        <button
          type="button"
          onClick={() => setValue(Math.max(min, +(value - step).toFixed(2)))}
          className="h-7 w-7 rounded border border-blue-300 bg-white text-sm font-bold text-blue-700 hover:bg-blue-50"
        >−</button>
        <span className="min-w-[42px] rounded border border-blue-300 bg-white px-2 py-1 text-center text-sm font-bold tabular-nums text-slate-800">
          {format ? format(value) : value}{suffix}
        </span>
        <button
          type="button"
          onClick={() => setValue(Math.min(max, +(value + step).toFixed(2)))}
          className="h-7 w-7 rounded border border-blue-300 bg-white text-sm font-bold text-blue-700 hover:bg-blue-50"
        >+</button>
        {hint && (
          <span className="ml-1 text-[10px] font-semibold text-blue-600">{hint}</span>
        )}
      </div>
    </div>
  )
}

// ─── Quick-add driver modal ──────────────────────────────────────────────────
//
// One-shot form for adding a single driver from the schedule step. After
// submit, the parent re-runs the scheduler so the new driver starts filling
// gaps right away — no need to go back to the Names step.

interface QuickAddDriverModalProps {
  open: boolean
  onClose: () => void
  onSubmit: (driver: { name: string; driverId?: string; employmentType: 'full' | 'part'; isShopper: boolean }) => void
}

function QuickAddDriverModal({ open, onClose, onSubmit }: QuickAddDriverModalProps) {
  const [name, setName] = useState('')
  const [driverId, setDriverId] = useState('')
  const [employmentType, setEmploymentType] = useState<'full' | 'part'>('full')
  const [isShopper, setIsShopper] = useState(false)

  useEffect(() => {
    if (!open) {
      // Reset on close so re-opening shows a fresh form.
      setName('')
      setDriverId('')
      setEmploymentType('full')
      setIsShopper(false)
    }
  }, [open])

  if (!open) return null

  const trimmedName = name.trim()
  const canSubmit = trimmedName.length > 0

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!canSubmit) return
    onSubmit({
      name: trimmedName,
      driverId: driverId.trim() || undefined,
      employmentType,
      isShopper,
    })
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/30 px-4"
      onClick={onClose}
    >
      <form
        className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-base font-semibold text-slate-800">Add driver to schedule</h3>
          <button type="button" onClick={onClose} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700">
            <X className="h-4 w-4" />
          </button>
        </div>

        <p className="mb-4 text-xs text-slate-500">
          The new driver will be added to the roster and the schedule re-generated.
          Existing assignments may shift to incorporate them.
        </p>

        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-xs font-semibold text-slate-700">
            Name <span className="text-slate-400">(required)</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Maria Garcia"
              autoFocus
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-normal text-slate-800 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-200"
            />
          </label>

          <label className="flex flex-col gap-1 text-xs font-semibold text-slate-700">
            Driver ID <span className="text-slate-400">(optional, for backend lookup)</span>
            <input
              type="text"
              value={driverId}
              onChange={(e) => setDriverId(e.target.value)}
              placeholder="e.g. cUZ2A5Q30pss1tBvtJ8W"
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-normal text-slate-800 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-200"
            />
          </label>

          <div className="flex flex-col gap-1">
            <span className="text-xs font-semibold text-slate-700">Term</span>
            <div className="flex gap-2">
              {(['full', 'part'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setEmploymentType(t)}
                  className={clsx(
                    'flex-1 rounded-lg border px-3 py-2 text-sm font-semibold transition',
                    employmentType === t
                      ? 'border-blue-500 bg-blue-50 text-blue-700'
                      : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-50',
                  )}
                >
                  {t === 'full' ? 'Full-time' : 'Part-time'}
                </button>
              ))}
            </div>
          </div>

          <label className="mt-1 flex cursor-pointer items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={isShopper}
              onChange={(e) => setIsShopper(e.target.checked)}
              className="h-4 w-4 rounded border-slate-300 text-purple-600 focus:ring-2 focus:ring-purple-200"
            />
            Shopper (groups at the bottom of each day grid + XLSX)
          </label>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!canSubmit}
            className={clsx(
              'flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold shadow-sm transition',
              canSubmit
                ? 'bg-blue-600 text-white hover:bg-blue-700'
                : 'cursor-not-allowed bg-slate-200 text-slate-400',
            )}
          >
            <Plus className="h-4 w-4" />
            Add &amp; regenerate
          </button>
        </div>
      </form>
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
    setFullTimeCap,
    setMaxHoursPerDay,
    setCoverageScale,
    addDriver,
  } = useDriverStore()
  const [expandedDates, setExpandedDates] = useState<Set<string>>(new Set())
  const [pdfLoading, setPdfLoading] = useState(false)
  const [showAllPills, setShowAllPills] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')
  const [quickAddOpen, setQuickAddOpen] = useState(false)
  // Simulation state — when set, shows a comparison row in the hiring
  // banner: "Adding N drivers would close the gap to Yh." Cleared
  // whenever the underlying schedule changes (regenerate, add driver,
  // apply suggestion).
  const [simResult, setSimResult] = useState<null | {
    addedCount: number
    shortfallBefore: number
    shortfallAfter: number
  }>(null)

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
    setSimResult(null)
  }

  // Add a new driver, then regenerate so they immediately appear in
  // the schedule and start filling gaps. Uses the up-to-date driver
  // list from the store after `addDriver` runs (synchronous Zustand set).
  const handleQuickAdd = (d: { name: string; driverId?: string; employmentType: 'full' | 'part'; isShopper: boolean }) => {
    addDriver(d.name, d.employmentType, { driverId: d.driverId, isShopper: d.isShopper })
    setQuickAddOpen(false)
    // Pull the fresh driver list from the store (post-addDriver).
    const freshDrivers = useDriverStore.getState().drivers
    regenSeed.current++
    const fresh = generateDriverSchedule({
      drivers: freshDrivers, startDate, endDate, timeOff,
      fullTimeCap, partTimeCap, coverageScale, coverageOverrides,
      minHoursPerDay, maxHoursPerDay,
      seed: weekendRotationOffset + regenSeed.current,
    })
    setSchedule(fresh)
    setExpandedDates(new Set())
    setSimResult(null)
  }

  // Run a hypothetical schedule with N placeholder FT drivers tacked
  // onto the roster, then report the shortfall before/after WITHOUT
  // mutating the real schedule or roster. Lets ops sanity-check the
  // hiring recommendation before committing.
  const handleSimulateHires = (n: number) => {
    const placeholders = Array.from({ length: n }, (_, i) => ({
      id: `__sim_${Date.now()}_${i}`,
      name: `New hire ${i + 1}`,
      color: '#94a3b8',
      employmentType: 'full' as const,
    }))
    const simSchedule = generateDriverSchedule({
      drivers: [...drivers, ...placeholders],
      startDate, endDate, timeOff,
      fullTimeCap, partTimeCap, coverageScale, coverageOverrides,
      minHoursPerDay, maxHoursPerDay,
      seed: weekendRotationOffset,
    })
    const simHealth = analyzeCoverageHealth(simSchedule, coverageScale, coverageOverrides)
    setSimResult({
      addedCount: n,
      shortfallBefore: health.weeklyShortfallHours,
      shortfallAfter: simHealth.weeklyShortfallHours,
    })
  }

  // Apply edits from the suggestions banner and regenerate in one shot.
  const handleApplyEdits = (next: { fullTimeCap: number; maxHoursPerDay: number; coverageScale: number }) => {
    setFullTimeCap(next.fullTimeCap)
    setMaxHoursPerDay(next.maxHoursPerDay)
    setCoverageScale(next.coverageScale)
    regenSeed.current++
    const fresh = generateDriverSchedule({
      drivers, startDate, endDate, timeOff,
      fullTimeCap: next.fullTimeCap, partTimeCap,
      coverageScale: next.coverageScale, coverageOverrides,
      minHoursPerDay, maxHoursPerDay: next.maxHoursPerDay,
      seed: weekendRotationOffset + regenSeed.current,
    })
    setSchedule(fresh)
    setExpandedDates(new Set())
    setSimResult(null)
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
      {/* Inline suggestions banner — only when there's any shortfall.
          Lets ops bump cap / max h-day / coverage scale and regenerate
          without walking back to the Period step. */}
      {health.weeklyShortfallHours > 0 && (
        <SuggestionsBanner
          shortfallHours={health.weeklyShortfallHours}
          fullTimeCap={fullTimeCap}
          maxHoursPerDay={maxHoursPerDay}
          coverageScale={coverageScale}
          onApply={handleApplyEdits}
        />
      )}
      {/* Hiring recommendation — only shown when the gap is big enough that
          adjusting cap/max likely won't close it. Below 20h/wk shortfall,
          the suggestions banner above is the right tool. */}
      {health.weeklyShortfallHours >= 20 && (
        <div className="flex items-start gap-3 rounded-2xl border border-amber-300 bg-amber-50 px-5 py-4 shadow-sm">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
          <div className="flex-1 text-sm text-amber-900">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-semibold">
                Minimum coverage not met — roster is {Math.round(health.weeklyShortfallHours)} driver-hours short per week.
              </span>
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold">
                <UserPlus className="h-3 w-3" />
                Hire {health.recommendedAdditionalDrivers} more full-time driver
                {health.recommendedAdditionalDrivers === 1 ? '' : 's'}
              </span>
              <button
                type="button"
                onClick={() => handleSimulateHires(health.recommendedAdditionalDrivers)}
                className="inline-flex items-center gap-1 rounded-full border border-amber-400 bg-white px-2.5 py-0.5 text-xs font-semibold text-amber-700 hover:bg-amber-100"
              >
                Simulate with {health.recommendedAdditionalDrivers} new hire
                {health.recommendedAdditionalDrivers === 1 ? '' : 's'}
              </button>
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
              {' '}Use the <span className="font-semibold">+ Add driver</span> button above to add bodies, or relax targets via Coverage scale.
            </p>

            {/* Simulation result — appears after the user clicks
                "Simulate with N new hires". Shows the projected impact
                on weekly shortfall WITHOUT mutating the real schedule. */}
            {simResult && (
              <div className="mt-3 rounded-xl border border-amber-300 bg-white px-3 py-2 text-xs text-amber-900">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold">
                    Simulation: + {simResult.addedCount} FT driver{simResult.addedCount === 1 ? '' : 's'}
                  </span>
                  <button
                    type="button"
                    onClick={() => setSimResult(null)}
                    className="rounded p-0.5 text-amber-600 hover:bg-amber-50"
                    title="Dismiss simulation"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
                <div className="mt-1 flex flex-wrap items-baseline gap-x-3">
                  <span>
                    Before: <span className="font-bold tabular-nums">{Math.round(simResult.shortfallBefore)}h/wk short</span>
                  </span>
                  <span className="text-amber-500">→</span>
                  <span>
                    After: <span className={clsx(
                      'font-bold tabular-nums',
                      simResult.shortfallAfter <= 0 ? 'text-emerald-700' : 'text-amber-900',
                    )}>
                      {Math.round(simResult.shortfallAfter)}h/wk short
                    </span>
                  </span>
                  {simResult.shortfallAfter <= 0 ? (
                    <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
                      ✓ Coverage met
                    </span>
                  ) : (
                    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-700">
                      Still {Math.round(simResult.shortfallAfter)}h short — try more hires
                    </span>
                  )}
                </div>
                <p className="mt-1 text-[11px] text-amber-700/80">
                  Hypothetical only — your schedule is unchanged. Use{' '}
                  <span className="font-semibold">+ Add driver</span> above to actually add a body and regenerate.
                </p>
              </div>
            )}
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
            onClick={() => setQuickAddOpen(true)}
            title="Add a driver and regenerate — pulls a new body straight into the gaps"
            className="flex items-center gap-2 rounded-xl border border-emerald-300 bg-emerald-50 px-4 py-2 text-sm font-semibold text-emerald-700 transition hover:bg-emerald-100"
          >
            <Plus className="h-4 w-4" />
            Add driver
          </button>
          <button
            onClick={handleRegenerate}
            className="flex items-center gap-2 rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
          >
            <RefreshCw className="h-4 w-4" />
            Regenerate
          </button>
          <button
            onClick={handleExportJson}
            title="Download a snapshot of the current schedule (roster, settings, all shifts). Reload it later to pick up exactly where you left off."
            className="flex items-center gap-2 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
          >
            <FileJson className="h-4 w-4" />
            Snapshot
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

        // Overtime tally — anyone over the legal 45h weekly max, plus
        // sum of overtime hours for the week's payroll picture. Computed
        // across BOTH FT and PT (the legal limit doesn't discriminate).
        const allWeekHours = schedule.driverSchedules.map((ds) => ds.weeklyHours[wl] ?? 0)
        const otDrivers = allWeekHours.filter((h) => h > LEGAL_WEEKLY_MAX_HOURS).length
        const otHours = allWeekHours.reduce((sum, h) => sum + Math.max(0, h - LEGAL_WEEKLY_MAX_HOURS), 0)
        // Daily overtime: count per-driver-days that exceed 9h
        let dailyOtDays = 0
        let dailyOtHours = 0
        for (const ds of schedule.driverSchedules) {
          for (const day of ds.days) {
            if (day.isOff) continue
            const dt = new Date(day.date + 'T12:00:00')
            // Only count days in this week
            if (schedule.dates.find((di) => di.date === day.date && di.weekLabel === wl)) {
              if ((day.totalHours ?? 0) > LEGAL_DAILY_MAX_HOURS) {
                dailyOtDays++
                dailyOtHours += (day.totalHours ?? 0) - LEGAL_DAILY_MAX_HOURS
              }
            }
            void dt
          }
        }

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
                    <HoverHint label={`${ftAtCap} full-time driver${ftAtCap === 1 ? '' : 's'} hit the ${fullTimeCap}h weekly cap this week`}>
                      <span className="font-semibold text-emerald-600">{ftAtCap}</span>
                    </HoverHint>{' '}at cap ·
                    <HoverHint label={`${ftUnder} full-time driver${ftUnder === 1 ? '' : 's'} worked this week but ended below the ${fullTimeCap}h cap — unused capacity available`}>
                      <span className="ml-1 font-semibold text-amber-600">{ftUnder}</span>
                    </HoverHint>{' '}under ·
                    {ftOff > 0 && (
                      <>
                        <HoverHint label={`${ftOff} full-time driver${ftOff === 1 ? '' : 's'} didn't get scheduled at all this week`}>
                          <span className="ml-1 font-semibold text-slate-500">{ftOff}</span>
                        </HoverHint>{' '}off ·
                      </>
                    )}
                    <HoverHint label={`${ptAtCap + ptUnder} part-time driver${(ptAtCap + ptUnder) === 1 ? '' : 's'} scheduled this week (${ptAtCap} at ${schedule.partTimeCap}h cap, ${ptUnder} under)`}>
                      <span className="ml-1 font-semibold text-blue-600">{ptAtCap + ptUnder}</span>
                    </HoverHint>{' '}PT
                  </div>
                  {/* Overtime tally — visible whenever any driver crosses 45h/wk or any
                      shift goes past 9h. Lets ops see legal exposure for payroll. */}
                  {(otDrivers > 0 || dailyOtDays > 0) && (
                    <span
                      className="flex items-center gap-1 rounded-full border border-purple-300 bg-purple-50 px-2.5 py-0.5 text-xs font-semibold text-purple-700"
                      title={[
                        otDrivers > 0 && `${otDrivers} driver${otDrivers === 1 ? '' : 's'} over 45h/wk → ${otHours.toFixed(1)}h weekly overtime`,
                        dailyOtDays > 0 && `${dailyOtDays} driver-day${dailyOtDays === 1 ? '' : 's'} over 9h → ${dailyOtHours.toFixed(1)}h daily overtime`,
                      ].filter(Boolean).join(' · ')}
                    >
                      ⚠ OT: {(otHours + dailyOtHours).toFixed(1)}h
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
              // Count slots + total bodies short. Per ops policy the
              // coverage targets are hard minimums (no ±15% allowance),
              // so every gap is a real gap — no "severe vs mild" split.
              const required = effectiveCoverage(dateInfo.dayOfWeek, coverageScale, coverageOverrides)
              let gapSlots = 0
              let gapBodies = 0
              for (let i = 0; i < required.length; i++) {
                const diff = required[i] - (actual[i] ?? 0)
                if (diff > 0) {
                  gapSlots++
                  gapBodies += diff
                }
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
                        className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700"
                        title={`${gapSlots} of ${required.length} hourly slot${gapSlots === 1 ? '' : 's'} below target (${gapBodies} driver-hour${gapBodies === 1 ? '' : 's'} short)`}
                      >
                        ⚠ {gapSlots} gap{gapSlots === 1 ? '' : 's'} ({gapBodies}h short)
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
            title="Download a snapshot of the current schedule (roster, settings, all shifts). Reload it later to pick up exactly where you left off."
            className="flex items-center gap-2 rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
          >
            <FileJson className="h-4 w-4" />
            Snapshot
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

      <QuickAddDriverModal
        open={quickAddOpen}
        onClose={() => setQuickAddOpen(false)}
        onSubmit={handleQuickAdd}
      />
    </div>
  )
}
