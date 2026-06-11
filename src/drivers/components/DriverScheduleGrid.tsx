import clsx from 'clsx'
import { AlertTriangle, CalendarClock, ChevronDown, ChevronRight, Clock, Download, FileJson, FileText, Lightbulb, Loader2, Plus, RefreshCw, Search, Shield, Shuffle, Undo2, Redo2, UserPlus, Users, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { downloadSnapshot, SCHEMA_VERSION } from '@/utils/snapshot'
import { DateRangePicker } from '@/components/DateRangePicker'
import { HoverHint } from '@/components/HoverHint'

import { DRIVER_SLOTS, effectiveCoverage, LEGAL_DAILY_MAX_HOURS, LEGAL_PT_WEEKLY_MAX_HOURS, LEGAL_WEEKLY_MAX_HOURS } from '../coverageTemplate'
import { RecurringBlocksEditor } from '@/components/RecurringBlocksEditor'
import { AbsenceRangeForm } from '@/components/AbsenceRangeForm'
import { caymanNow, caymanTimeLabel } from '@/utils/caymanTime'

import { addDriverIncremental, analyzeCoverageHealth, generateDriverSchedule, hoursStatusBg, slideScheduleDates } from '../scheduler'
import { shuffleDriverSchedules } from '../shuffler'
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

// ─── Per-week headcount-limited banner ───────────────────────────────────────
//
// Shown inside each week card when the scheduler couldn't reach the 40%
// coverage floor on one or more priority slots for THAT week, even after
// all redistribution phases. Per-week so admins see the bad days right
// above the day rows for those days, not as one giant top-of-page list
// for multi-week schedules.
//
// Distinct from the "Coverage is X hours short" suggestions banner: those
// are distribution problems the optimizer might fix by tweaking knobs.
// This banner is for slots where adding bodies is the only way out.

interface WeekHeadcountBannerProps {
  slots: import('../types').HeadcountLimitedSlot[]
}

function WeekHeadcountBanner({ slots }: WeekHeadcountBannerProps) {
  if (slots.length === 0) return null
  // Group by date so the listing reads "Wed: 10 PM (2/5), 7 PM (21/36)"
  // instead of a flat per-slot dump.
  const byDate = new Map<string, typeof slots>()
  for (const s of slots) {
    if (!byDate.has(s.date)) byDate.set(s.date, [])
    byDate.get(s.date)!.push(s)
  }
  const totalHoursShort = slots.reduce((a, s) => a + s.hoursShortOfFloor, 0)
  // Rough driver-count estimate: the LARGER of (a) the deepest single-slot
  // deficit (one new driver covers one body per slot) and (b) total hours
  // ÷ 5 (a short closer-only shift contributes ~5 slot-hours). This is
  // intentionally rough — ops just wants a sense of "1 hire vs 5 hires".
  const maxDeficit = slots.reduce((a, s) => Math.max(a, s.hoursShortOfFloor), 0)
  const approxDrivers = Math.max(maxDeficit, Math.ceil(totalHoursShort / 5))

  return (
    <div className="mx-5 mt-3 flex items-start gap-3 rounded-xl border border-red-300 bg-red-50 px-4 py-3">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
      <div className="flex-1 text-xs text-red-900">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-semibold">
            {slots.length} slot{slots.length === 1 ? '' : 's'} below the 40% floor — headcount is short here.
          </span>
          <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-semibold">
            <UserPlus className="h-3 w-3" />
            ~{approxDrivers} more driver{approxDrivers === 1 ? '' : 's'} needed
          </span>
          <span className="text-[11px] text-red-700/80 tabular-nums">
            ({totalHoursShort} driver-hour{totalHoursShort === 1 ? '' : 's'} short)
          </span>
        </div>
        <div className="mt-2 grid gap-1">
          {[...byDate.entries()].map(([date, daySlots]) => (
            <div key={date} className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-semibold">{daySlots[0].dayLabel}:</span>
              {daySlots
                .sort((a, b) => a.slotIndex - b.slotIndex)
                .map((s, i) => (
                  <span key={s.slotIndex} className="tabular-nums">
                    {i > 0 && <span className="mr-1 text-red-400">·</span>}
                    <span className="font-semibold">{s.slotLabel}</span>{' '}
                    <span className="rounded bg-red-100 px-1.5 py-0.5 text-[11px] font-bold text-red-700">
                      {s.achieved} of {s.target}
                    </span>{' '}
                    <span className="text-red-700/70">(floor {s.floor})</span>
                  </span>
                ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ─── Inline coverage-scale adjuster (schedule step) ──────────────────────────
//
// Lightweight wrapper around the same coverage-scale control exposed in
// the Period step and the Suggestions banner. Lives in the schedule
// step's header strip so ops can tweak target demand and regenerate
// without bouncing back to Period. Apply button only enabled when the
// pending value differs from the current store value — avoids accidental
// regenerations from a stray click.

interface CoverageScaleAdjusterProps {
  coverageScale: number
  onApply: (nextScale: number) => void
}

function CoverageScaleAdjuster({ coverageScale, onApply }: CoverageScaleAdjusterProps) {
  const [scale, setScale] = useState(coverageScale)
  // Reset pending value when the underlying store value changes (e.g. a
  // regenerate happened from elsewhere, the suggestions banner applied,
  // or the user went back to Period).
  useEffect(() => { setScale(coverageScale) }, [coverageScale])
  const dirty = scale !== coverageScale
  const deltaPct = Math.round((scale - 1) * 100)
  const step = 0.05
  const min = 0.5
  const max = 1.5

  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="font-semibold uppercase tracking-wide text-slate-500">Coverage</span>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => setScale((s) => Math.max(min, +(s - step).toFixed(2)))}
          className="h-6 w-6 rounded border border-slate-300 bg-white text-sm font-bold text-slate-700 hover:bg-slate-50"
          aria-label="Decrease coverage scale"
        >−</button>
        <span className="min-w-[44px] rounded border border-slate-300 bg-white px-2 py-0.5 text-center text-xs font-bold tabular-nums text-slate-800">
          {scale.toFixed(2)}×
        </span>
        <button
          type="button"
          onClick={() => setScale((s) => Math.min(max, +(s + step).toFixed(2)))}
          className="h-6 w-6 rounded border border-slate-300 bg-white text-sm font-bold text-slate-700 hover:bg-slate-50"
          aria-label="Increase coverage scale"
        >+</button>
      </div>
      <span
        className={clsx(
          'tabular-nums text-[11px]',
          deltaPct > 0 ? 'text-emerald-700' : deltaPct < 0 ? 'text-amber-700' : 'text-slate-400',
        )}
        title={
          deltaPct === 0
            ? 'Baseline coverage targets (no scale applied)'
            : deltaPct > 0
              ? `Targets scaled UP by ${deltaPct}% — more bodies needed in every slot`
              : `Targets scaled DOWN by ${Math.abs(deltaPct)}% — fewer bodies needed in every slot`
        }
      >
        {deltaPct > 0 ? `+${deltaPct}%` : `${deltaPct}%`}
      </span>
      {dirty && (
        <button
          type="button"
          onClick={() => onApply(scale)}
          className="flex items-center gap-1 rounded-lg bg-blue-600 px-2.5 py-1 text-[11px] font-semibold text-white shadow-sm transition hover:bg-blue-700"
        >
          <RefreshCw className="h-3 w-3" />
          Apply
        </button>
      )}
      {dirty && (
        <button
          type="button"
          onClick={() => setScale(coverageScale)}
          className="text-[11px] font-medium text-slate-500 underline-offset-2 hover:text-slate-700 hover:underline"
        >
          reset
        </button>
      )}
    </div>
  )
}

// ─── Drill-down driver list modal ─────────────────────────────────────────────
//
// Opens when ops clicks any of the week-header counts (at cap, under,
// FT off, PT count, or the 1d/2d/3d/4d+ off pills). Lists the actual
// drivers in that bucket so ops can spot who's driving the number
// without scrolling the full pill list.

interface DrillDownRow {
  id: string
  name: string
  employmentType: 'full' | 'part'
  isShopper: boolean
  hours: number
  cap: number
  daysWorked: number
  daysOff: number
}

interface DriverDrillDownModalProps {
  open: boolean
  onClose: () => void
  title: string
  subtitle?: string
  rows: DrillDownRow[]
  /** Optional callback per-row: when set, each row gets an "Edit
   *  availability" button that calls this with the driver id. */
  onEditDriver?: (driverId: string) => void
}

function DriverDrillDownModal({ open, onClose, title, subtitle, rows, onEditDriver }: DriverDrillDownModalProps) {
  if (!open) return null
  // Sort by hours descending so the biggest-impact drivers (most hours
  // for "at cap" / fewest for "off") read first. Stable sort preserves
  // original roster order on equal hours.
  const sorted = [...rows].sort((a, b) => b.hours - a.hours)

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/30 px-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-md flex-col rounded-2xl bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-3">
          <div className="min-w-0">
            <h3 className="truncate text-base font-semibold text-slate-800">{title}</h3>
            {subtitle && (
              <p className="mt-0.5 truncate text-xs text-slate-500">{subtitle}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-3">
          {sorted.length === 0 ? (
            <p className="py-6 text-center text-sm text-slate-400">No drivers match.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-slate-100">
              {sorted.map((r) => {
                const pct = r.cap > 0 ? Math.round((r.hours / r.cap) * 100) : 0
                return (
                  <li key={r.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-semibold text-slate-800">{displayName(r.name)}</span>
                        <span
                          className={clsx(
                            'rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase',
                            r.isShopper
                              ? 'bg-purple-100 text-purple-700'
                              : r.employmentType === 'full'
                                ? 'bg-emerald-100 text-emerald-700'
                                : 'bg-blue-100 text-blue-700',
                          )}
                          title={r.isShopper ? 'Shopper' : r.employmentType === 'full' ? 'Full-time' : 'Part-time'}
                        >
                          {r.isShopper ? 'shopper' : r.employmentType === 'full' ? 'FT' : 'PT'}
                        </span>
                      </div>
                      <div className="mt-0.5 text-xs text-slate-500">
                        {r.daysWorked} day{r.daysWorked === 1 ? '' : 's'} worked · {r.daysOff} day{r.daysOff === 1 ? '' : 's'} off
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <div className="text-right tabular-nums">
                        <div
                          className={clsx(
                            'rounded-full border px-2 py-0.5 text-xs font-semibold',
                            hoursStatusBg(r.hours, r.cap),
                          )}
                        >
                          {r.hours}h / {r.cap}h
                        </div>
                        <div className="mt-0.5 text-[10px] text-slate-400">{pct}%</div>
                      </div>
                      {onEditDriver && (
                        <button
                          type="button"
                          onClick={() => { onClose(); onEditDriver(r.id) }}
                          title="Edit recurring weekly blocks + time-off for this driver"
                          className="rounded-md border border-slate-200 bg-white p-1 text-slate-500 hover:bg-slate-50 hover:text-slate-700"
                          aria-label="Edit availability"
                        >
                          <CalendarClock className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        <div className="border-t border-slate-100 px-5 py-2 text-xs text-slate-500">
          {sorted.length} driver{sorted.length === 1 ? '' : 's'} in this bucket
        </div>
      </div>
    </div>
  )
}

// ─── Driver availability editor (modal) ──────────────────────────────────────
//
// Lets ops adjust a driver's recurring weekly blocks + per-date time-off
// from the schedule step, without leaving the schedule view or walking
// back to Names. Critical for the pending-availability workflow: when a
// late-confirming driver (e.g. Andre) sends in updated blocks, ops needs
// to record them BEFORE clicking "Confirm & add" so the incremental
// placement honors the new constraints.
//
// Edits write straight to the store via the same actions the Names step
// uses (`toggleRecurringBlock`, `setRecurringBlocks`, `applyAbsenceRange`).
// They do NOT trigger a regenerate — that would re-shuffle the whole
// schedule and defeat the point of editing one driver in isolation.

interface DriverAvailabilityModalProps {
  open: boolean
  onClose: () => void
  driverId: string | null
  /** Schedule period bounds — passed to the date-range absence form so
   *  the date inputs can't pick outside the active window. */
  minDate: string
  maxDate: string
}

function DriverAvailabilityModal({ open, onClose, driverId, minDate, maxDate }: DriverAvailabilityModalProps) {
  const driver = useDriverStore((s) =>
    driverId ? s.drivers.find((d) => d.id === driverId) ?? null : null,
  )
  const toggleRecurringBlock = useDriverStore((s) => s.toggleRecurringBlock)
  const setRecurringBlocks = useDriverStore((s) => s.setRecurringBlocks)
  const applyAbsenceRange = useDriverStore((s) => s.applyAbsenceRange)
  const updateDriverInfo = useDriverStore((s) => s.updateDriverInfo)
  const [showAbsenceForm, setShowAbsenceForm] = useState(false)
  // Local-edit buffers for the basic-info section so typing in the
  // name / driverId fields doesn't fire a store write per keystroke
  // (which would re-render the whole schedule view each time). The
  // committed values land on blur via updateDriverInfo.
  const [nameDraft, setNameDraft] = useState('')
  const [driverIdDraft, setDriverIdDraft] = useState('')
  // Reset the inline-form visibility every time the modal closes so it
  // re-opens fresh.
  useEffect(() => { if (!open) setShowAbsenceForm(false) }, [open])
  // Seed the local drafts from the driver record whenever we switch
  // drivers or re-open the modal. Without this the previous driver's
  // text would leak into a freshly-opened editor.
  useEffect(() => {
    if (driver) {
      setNameDraft(driver.name)
      setDriverIdDraft(driver.driverId ?? '')
    }
  }, [driver?.id, open])

  if (!open || !driver) return null

  const commitName = () => {
    const trimmed = nameDraft.trim()
    if (trimmed.length === 0 || trimmed === driver.name) {
      setNameDraft(driver.name)
      return
    }
    updateDriverInfo(driver.id, { name: trimmed })
  }
  const commitDriverId = () => {
    const trimmed = driverIdDraft.trim()
    if (trimmed === (driver.driverId ?? '')) return
    updateDriverInfo(driver.id, { driverId: trimmed })
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/30 px-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-3xl flex-col rounded-2xl bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-3">
          <div className="min-w-0">
            <h3 className="truncate text-base font-semibold text-slate-800">
              Manage driver — {displayName(driver.name)}
            </h3>
            <p className="mt-0.5 text-xs text-slate-500">
              Edits apply to <span className="font-semibold">this driver only</span> and don't trigger a regenerate.
              {driver.pendingAvailability && (
                <span className="ml-1 text-amber-700">
                  Set their blocks before clicking <span className="font-semibold">Confirm &amp; add</span> on the banner.
                </span>
              )}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-3">
          {/* Basic driver info — name, driverId, term, shopper toggle.
              Drafts commit on blur or Enter so we don't thrash the
              store on every keystroke. Term and shopper toggle commit
              immediately on click. Switching the shopper flag triggers
              a coverageActual recount in the store action so the day
              grid reflects the new pool assignment without a regen. */}
          <div className="mb-4">
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
              Driver info
            </h4>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-xs font-semibold text-slate-700">
                Name
                <input
                  type="text"
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  onBlur={commitName}
                  onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                  className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-normal text-slate-800 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-200"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs font-semibold text-slate-700">
                Driver ID <span className="text-slate-400">(backend lookup, optional)</span>
                <input
                  type="text"
                  value={driverIdDraft}
                  onChange={(e) => setDriverIdDraft(e.target.value)}
                  onBlur={commitDriverId}
                  onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
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
                      onClick={() => updateDriverInfo(driver.id, { employmentType: t })}
                      className={clsx(
                        'flex-1 rounded-lg border px-3 py-2 text-sm font-semibold transition',
                        driver.employmentType === t
                          ? 'border-blue-500 bg-blue-50 text-blue-700'
                          : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-50',
                      )}
                    >
                      {t === 'full' ? 'Full-time' : 'Part-time'}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-xs font-semibold text-slate-700">Role</span>
                <button
                  type="button"
                  onClick={() => updateDriverInfo(driver.id, { isShopper: !driver.isShopper })}
                  className={clsx(
                    'flex items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-semibold transition',
                    driver.isShopper
                      ? 'border-violet-400 bg-violet-50 text-violet-700 hover:bg-violet-100'
                      : 'border-slate-300 bg-white text-slate-500 hover:bg-slate-50',
                  )}
                  title={driver.isShopper
                    ? 'Currently a shopper — counts toward grocery coverage, not driver coverage. Click to revert to driver.'
                    : 'Currently a driver — counts toward driver coverage. Click to mark as shopper (grocery pool).'}
                >
                  <Users className="h-4 w-4" />
                  {driver.isShopper ? 'Shopper (click to revert)' : 'Mark as shopper'}
                </button>
              </div>
            </div>
            {driver.isShopper && (
              <p className="mt-2 text-[11px] text-violet-700/90">
                As a shopper, this driver counts toward the grocery coverage pool and is excluded from driver
                coverage targets in the day grid. Toggling this updates the displayed coverage immediately.
              </p>
            )}
          </div>

          <div className="mb-4 border-t border-slate-100 pt-4">
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
              Recurring weekly blocks
            </h4>
            <RecurringBlocksEditor
              blocks={driver.recurringBlocks}
              slots={DRIVER_SLOTS}
              accentColor={driver.color}
              onToggle={(dow, si) => toggleRecurringBlock(driver.id, dow, si)}
              onSetAll={(blocks) => setRecurringBlocks(driver.id, blocks)}
            />
          </div>

          <div>
            <div className="mb-2 flex items-baseline justify-between gap-2">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Time-off for this schedule period
              </h4>
              {!showAbsenceForm && (
                <button
                  type="button"
                  onClick={() => setShowAbsenceForm(true)}
                  className="inline-flex items-center gap-1 rounded-md border border-blue-300 bg-blue-50 px-2 py-0.5 text-[11px] font-semibold text-blue-700 hover:bg-blue-100"
                >
                  <Plus className="h-3 w-3" />
                  Add absence
                </button>
              )}
            </div>
            {showAbsenceForm ? (
              <AbsenceRangeForm
                minDate={minDate}
                maxDate={maxDate}
                slots={DRIVER_SLOTS}
                onApply={(start, end, reason, slotMask) => {
                  applyAbsenceRange(driver.id, start, end, reason, slotMask)
                  setShowAbsenceForm(false)
                }}
                onCancel={() => setShowAbsenceForm(false)}
              />
            ) : (
              <p className="text-[11px] text-slate-400">
                Add one-off absences (vacation, sick, partial-day) for any date in the current schedule period.
              </p>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-slate-100 px-5 py-2">
          <span className="text-[11px] text-slate-500">
            Changes save automatically.
          </span>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-slate-800 px-3 py-1 text-xs font-semibold text-white hover:bg-slate-700"
          >
            Done
          </button>
        </div>
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
    setDateRange,
    setFullTimeCap,
    setMaxHoursPerDay,
    setCoverageScale,
    addDriver,
    setPendingAvailability,
    undoScheduleEdit,
    redoScheduleEdit,
    applyShuffledSchedule,
  } = useDriverStore()
  // Track undo/redo button enabled state. We can't use the canUndo/canRedo
  // selectors directly here because they're functions, so subscribe via the
  // stack lengths instead — those re-render the component when toggle hits.
  const undoCount = useDriverStore((s) => s.scheduleUndoStack.length)
  const redoCount = useDriverStore((s) => s.scheduleRedoStack.length)

  // Per-minute tick that drives the current-time indicator. Each tick
  // bumps a state value so `caymanNow()` is re-read on the next render
  // and any visible <NowLine /> re-positions. Aligning the first
  // interval to the next wall-clock minute boundary makes the line jump
  // exactly when the minute changes (not e.g. 47s late).
  const [nowTick, setNowTick] = useState(0)
  useEffect(() => {
    const now = new Date()
    const msToNextMinute = (60 - now.getSeconds()) * 1000 - now.getMilliseconds()
    let interval: number | undefined
    const firstTimer = window.setTimeout(() => {
      setNowTick((t) => t + 1)
      interval = window.setInterval(() => setNowTick((t) => t + 1), 60_000)
    }, msToNextMinute)
    return () => {
      window.clearTimeout(firstTimer)
      if (interval !== undefined) window.clearInterval(interval)
    }
  }, [])
  // Read on every render. nowTick is in deps even though we don't use
  // its value — its only purpose is forcing this re-render each minute.
  void nowTick
  const now = caymanNow()
  // Ops opens 8 AM, closes 11 PM. Outside that range → no line shown
  // (caller passes undefined props to DriverDayGrid).
  const nowSlotIdx = (now.hours >= 8 && now.hours < 23) ? now.hours - 8 : -1
  const nowMinuteFrac = now.minutes / 60
  const nowDateISO = now.dateISO
  // Live coverage at the current slot — actual driver count + per-slot
  // target — so the NOW pill reads e.g. "NOW · 14:32 · 23/25" and
  // fleet admins see at a glance whether they're at target right now.
  // Skips shoppers (they live in a separate pool — coverageActual
  // is already shopper-excluded by the scheduler).
  const nowCounts = (() => {
    if (!schedule || nowSlotIdx < 0) return null
    const actual = schedule.coverageActual[nowDateISO]?.[nowSlotIdx] ?? 0
    const todayDate = schedule.dates.find((d) => d.date === nowDateISO)
    const target = todayDate
      ? effectiveCoverage(todayDate.dayOfWeek, coverageScale, coverageOverrides)[nowSlotIdx] ?? 0
      : 0
    return { actual, target }
  })()
  const nowCountsLabel = nowCounts ? ` · ${nowCounts.actual}/${nowCounts.target}` : ''
  const nowLabel = `NOW · ${caymanTimeLabel()}${nowCountsLabel}`
  const canUndo = undoCount > 0
  const canRedo = redoCount > 0

  // Keyboard shortcut: Cmd/Ctrl+Z undoes the last slot-toggle edit,
  // Cmd/Ctrl+Shift+Z (or Cmd/Ctrl+Y) redoes. Skips when the focus is
  // inside an editable element so we don't hijack the user's text input.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (!mod) return
      const tgt = e.target as HTMLElement | null
      if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable)) {
        return
      }
      const key = e.key.toLowerCase()
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault()
        undoScheduleEdit()
      } else if ((key === 'z' && e.shiftKey) || key === 'y') {
        e.preventDefault()
        redoScheduleEdit()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [undoScheduleEdit, redoScheduleEdit])
  const [expandedDates, setExpandedDates] = useState<Set<string>>(new Set())
  const [pdfLoading, setPdfLoading] = useState(false)
  const [showAllPills, setShowAllPills] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')
  const [quickAddOpen, setQuickAddOpen] = useState(false)
  // Drill-down modal state — set when ops clicks one of the week-header
  // counts (at cap, under, FT off, PT, or any of the 1d/2d/3d/4d+ off
  // pills). Cleared by close. Two fields: `wl` (which week) and `kind`
  // (which bucket inside that week).
  type DrillKind = 'ftAtCap' | 'ftUnder' | 'ftOff' | 'pt' | '1d' | '2d' | '3d' | '4d+'
  const [drillDown, setDrillDown] = useState<null | { wl: string; kind: DrillKind }>(null)
  // Availability-editor modal state — id of the driver whose recurring
  // blocks + time-off are being edited from the schedule view. Cleared
  // by close. Drives the DriverAvailabilityModal at the bottom of the
  // page; changes apply immediately to the store and don't trigger a
  // regenerate, so other drivers' shifts stay put.
  const [editingAvailability, setEditingAvailability] = useState<string | null>(null)
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

  // Shuffle — rotates patterns across compatible drivers WITHOUT re-running
  // the scheduler. Coverage stays exactly the same (patterns move intact
  // as closed pairs), and Cmd+Z reverses the rotation because we route
  // through applyShuffledSchedule which pushes to the undo stack. Each
  // click uses a new seed so successive shuffles produce different
  // rotations.
  const shuffleSeed = useRef(Date.now() & 0xffff)
  const handleShuffle = () => {
    if (!schedule) return
    shuffleSeed.current = (shuffleSeed.current + 1 + Math.floor(Math.random() * 1000)) & 0xffff
    const shuffled = shuffleDriverSchedules(schedule, timeOff, shuffleSeed.current)
    applyShuffledSchedule(shuffled)
    setExpandedDates(new Set())
  }

  // Add a new driver, then regenerate so they immediately appear in
  // the schedule and start filling gaps. Uses the up-to-date driver
  // list from the store after `addDriver` runs (synchronous Zustand set).
  const handleQuickAdd = (d: { name: string; driverId?: string; employmentType: 'full' | 'part'; isShopper: boolean }) => {
    addDriver(d.name, d.employmentType, { driverId: d.driverId, isShopper: d.isShopper })
    setQuickAddOpen(false)
    if (!schedule) return
    // Incremental placement — every existing driver's shifts are kept
    // intact, only the new driver gets new entries placed into current
    // coverage gaps. NO full regenerate; no churn. The new driver is
    // the last entry in the store's drivers array (just appended by
    // addDriver), pull it out by name+type match to avoid race vs the
    // synchronous Zustand set.
    const freshDrivers = useDriverStore.getState().drivers
    const newDriver = freshDrivers[freshDrivers.length - 1]
    const result = addDriverIncremental({
      schedule,
      newDriver,
      timeOff,
      coverageScale, coverageOverrides,
      minHoursPerDay, maxHoursPerDay,
    })
    setSchedule(result.schedule)
    setExpandedDates(new Set())
    setSimResult(null)
    if (result.underUtilized) {
      // Surface the gap-shortage hint in the simResult slot, since the
      // hiring banner already renders that area cleanly.
      console.warn(
        `[add driver] ${newDriver.name} placed at ${result.assignedHours}h / ${result.weeklyCap}h-per-week cap. Not enough coverage gaps in current schedule to absorb their full capacity. Use Regenerate to re-balance if you want to use all their hours.`
      )
    }
  }

  // "Confirm & add" for a pending-availability driver. Clears the
  // pending flag in the roster, then runs the SAME addDriverIncremental
  // path as quick-add so the driver gets slotted into the existing
  // schedule without re-running the generator. Every other driver's
  // shifts stay intact.
  const handleConfirmPending = (driverId: string) => {
    setPendingAvailability(driverId, false)
    if (!schedule) return
    const freshDrivers = useDriverStore.getState().drivers
    const driver = freshDrivers.find((d) => d.id === driverId)
    if (!driver) return
    const result = addDriverIncremental({
      schedule,
      newDriver: driver,
      timeOff,
      coverageScale, coverageOverrides,
      minHoursPerDay, maxHoursPerDay,
    })
    setSchedule(result.schedule)
    setSimResult(null)
    if (result.underUtilized) {
      console.warn(
        `[confirm pending] ${driver.name} placed at ${result.assignedHours}h / ${result.weeklyCap}h-per-week cap. Not enough coverage gaps to absorb their full capacity — use Regenerate if you want to rebalance.`
      )
    }
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

  // Inline date-range edit from the Schedule header. The default
  // behavior is now SLIDE — when the new range is a pure 7-day-aligned
  // shift of the current schedule (same length, offset divisible by 7),
  // the existing driver-shift distribution is re-keyed to the new dates
  // without re-running the optimizer. This preserves any manual edits
  // and the current shift assignments — ops can "publish next week"
  // with one date change instead of regenerating + re-applying manual
  // tweaks.
  //
  // Falls back to a full regenerate when:
  //   - the new range has a different length (slide can't fill / drop
  //     days while keeping a valid distribution)
  //   - the new start day-of-week differs from the old (offset not a
  //     multiple of 7), since the driver patterns are weekday-specific
  //
  // The Regenerate button stays available for ops who explicitly want
  // a fresh optimizer run on the new dates.
  const handleDateRangeChange = (s: string, e: string) => {
    setDateRange(s, e)
    if (!s || !e || e < s) return
    const slid = schedule ? slideScheduleDates(schedule, s, e) : null
    if (slid) {
      setSchedule(slid)
      setExpandedDates(new Set())
      setSimResult(null)
      return
    }
    // Shape changed — full regenerate.
    regenSeed.current++
    const fresh = generateDriverSchedule({
      drivers, startDate: s, endDate: e, timeOff,
      fullTimeCap, partTimeCap, coverageScale, coverageOverrides,
      minHoursPerDay, maxHoursPerDay,
      seed: weekendRotationOffset + regenSeed.current,
    })
    setSchedule(fresh)
    setExpandedDates(new Set())
    setSimResult(null)
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

  // Drivers flagged as "pending availability" — excluded from generation,
  // surfaced in a banner with a "Confirm & add" action that incrementally
  // adds them once availability arrives.
  const pendingDrivers = drivers.filter((d) => d.pendingAvailability)

  return (
    <div className="flex flex-col gap-6">
      {/* Pending-availability banner — only when at least one roster
          driver has the flag set. Listing each driver with a one-click
          "Confirm & add" action that slots them into the existing
          schedule via addDriverIncremental (no full regenerate).
          The flag is honored on the NEXT generation; if you toggle a
          driver to pending AFTER generating, their old shifts persist
          until you regenerate. The banner doesn't try to differentiate
          — just says "marked pending" and lets ops decide. */}
      {pendingDrivers.length > 0 && (
        <div className="flex items-start gap-3 rounded-2xl border border-amber-300 bg-amber-50 px-5 py-4 shadow-sm">
          <Clock className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
          <div className="flex-1 text-sm text-amber-900">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-semibold">
                {pendingDrivers.length} driver{pendingDrivers.length === 1 ? '' : 's'} marked pending availability.
              </span>
              <span className="text-xs text-amber-800/80">
                Click <span className="font-semibold">Confirm &amp; add</span> once availability arrives — slots them in without re-running the generator (existing assignments stay put).
              </span>
            </div>
            <ul className="mt-3 flex flex-wrap gap-2">
              {pendingDrivers.map((d) => (
                <li
                  key={d.id}
                  className="inline-flex items-center gap-2 rounded-full border border-amber-300 bg-white px-3 py-1 text-xs"
                >
                  <span className="font-semibold text-slate-800">{displayName(d.name)}</span>
                  <span
                    className={clsx(
                      'rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase',
                      d.isShopper
                        ? 'bg-purple-100 text-purple-700'
                        : d.employmentType === 'full'
                          ? 'bg-emerald-100 text-emerald-700'
                          : 'bg-blue-100 text-blue-700',
                    )}
                  >
                    {d.isShopper ? 'shopper' : d.employmentType === 'full' ? 'FT' : 'PT'}
                  </span>
                  <button
                    type="button"
                    onClick={() => setEditingAvailability(d.id)}
                    title="Edit recurring weekly blocks + time-off for this driver before slotting them in. Doesn't trigger a regenerate."
                    className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-white px-2 py-0.5 text-[11px] font-semibold text-amber-700 transition hover:bg-amber-50"
                  >
                    <CalendarClock className="h-3 w-3" />
                    Edit availability
                  </button>
                  <button
                    type="button"
                    onClick={() => handleConfirmPending(d.id)}
                    className="inline-flex items-center gap-1 rounded-full bg-emerald-600 px-2 py-0.5 text-[11px] font-semibold text-white transition hover:bg-emerald-700"
                  >
                    <Plus className="h-3 w-3" />
                    Confirm &amp; add
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
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

      <div className="flex flex-wrap items-end justify-between gap-4 rounded-2xl border border-slate-200 bg-white px-5 py-4 shadow-sm">
        <div className="flex flex-col gap-2">
          <DateRangePicker
            startDate={startDate}
            endDate={endDate}
            onChange={handleDateRangeChange}
            label="Schedule period"
            compact
            showStats
          />
          <div className="text-xs text-slate-500">
            <span className="font-semibold text-slate-700">{drivers.length}</span> drivers ·
            full-time cap <span className="font-semibold text-slate-700">{fullTimeCap}h</span> ·
            part-time cap <span className="font-semibold text-slate-700">{schedule.partTimeCap}h</span>
          </div>
          {/* Inline coverage-scale knob — same control as Period step, also
              available in the suggestions banner. Surfaced here so ops can
              tweak coverage demand and regenerate without leaving the
              schedule view. Apply button only enabled when scale ≠ current. */}
          <CoverageScaleAdjuster
            coverageScale={coverageScale}
            onApply={(nextScale) =>
              handleApplyEdits({ fullTimeCap, maxHoursPerDay, coverageScale: nextScale })
            }
          />
        </div>
        <div className="flex gap-2">
          {/* Undo / Redo — only enabled when there's something on the stack.
              Keyboard shortcuts are Cmd/Ctrl+Z and Cmd/Ctrl+Shift+Z (or Y),
              wired in the useEffect above. */}
          <button
            onClick={undoScheduleEdit}
            disabled={!canUndo}
            title={canUndo ? `Undo last edit (${undoCount} in history) — Cmd/Ctrl+Z` : 'Nothing to undo'}
            className="flex items-center gap-1 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Undo2 className="h-4 w-4" />
            <span className="hidden sm:inline">Undo</span>
          </button>
          <button
            onClick={redoScheduleEdit}
            disabled={!canRedo}
            title={canRedo ? `Redo (${redoCount} available) — Cmd/Ctrl+Shift+Z` : 'Nothing to redo'}
            className="flex items-center gap-1 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Redo2 className="h-4 w-4" />
            <span className="hidden sm:inline">Redo</span>
          </button>
          <button
            onClick={() => setQuickAddOpen(true)}
            title="Add a driver and regenerate — pulls a new body straight into the gaps"
            className="flex items-center gap-2 rounded-xl border border-emerald-300 bg-emerald-50 px-4 py-2 text-sm font-semibold text-emerald-700 transition hover:bg-emerald-100"
          >
            <Plus className="h-4 w-4" />
            Add driver
          </button>
          <button
            onClick={handleShuffle}
            title="Rotate which driver works which schedule — coverage stays exactly the same. Each click randomizes pairings among compatible drivers. Cmd+Z to undo."
            className="flex items-center gap-2 rounded-xl border border-indigo-300 bg-indigo-50 px-4 py-2 text-sm font-medium text-indigo-700 transition hover:bg-indigo-100"
          >
            <Shuffle className="h-4 w-4" />
            Shuffle
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

        // Days-off distribution across all NON-SHOPPER staff this week.
        // Shoppers always work 6 non-Sundays so excluding them keeps the
        // "days off" tally focused on the driver pool the user controls.
        // Buckets:
        //   1d off = 6 days worked (one day off this work-week)
        //   2d off = 5 days worked
        //   3d off = 4 days worked
        //   4d+ off = 3 or fewer days worked (folded into one bucket)
        const dayOffBuckets = { '1d': 0, '2d': 0, '3d': 0, '4d+': 0 }
        const weekDateSet = new Set(weekDates.map((di) => di.date))
        for (const ds of schedule.driverSchedules) {
          if (ds.driver.isShopper) continue
          let worked = 0
          for (const e of ds.days) {
            if (weekDateSet.has(e.date) && !e.isOff) worked++
          }
          if (worked === 0) continue  // already counted as "off"
          const off = 7 - worked
          if (off === 1) dayOffBuckets['1d']++
          else if (off === 2) dayOffBuckets['2d']++
          else if (off === 3) dayOffBuckets['3d']++
          else if (off >= 4) dayOffBuckets['4d+']++
        }

        // Overtime tally — over the legal weekly max for that driver's
        // employment type (FT 45h, PT 30h). Computed across both pools
        // for the week's payroll picture.
        let otDrivers = 0
        let otHours = 0
        for (const ds of schedule.driverSchedules) {
          const h = ds.weeklyHours[wl] ?? 0
          const max = ds.driver.employmentType === 'full' ? LEGAL_WEEKLY_MAX_HOURS : LEGAL_PT_WEEKLY_MAX_HOURS
          if (h > max) {
            otDrivers++
            otHours += h - max
          }
        }
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
                    <HoverHint label={`Click to see the ${ftAtCap} full-time driver${ftAtCap === 1 ? '' : 's'} that hit the ${fullTimeCap}h weekly cap`}>
                      <button
                        type="button"
                        onClick={() => setDrillDown({ wl, kind: 'ftAtCap' })}
                        className="font-semibold text-emerald-600 hover:underline"
                      >
                        {ftAtCap}
                      </button>
                    </HoverHint>{' '}at cap ·
                    <HoverHint label={`Click to see the ${ftUnder} full-time driver${ftUnder === 1 ? '' : 's'} below the ${fullTimeCap}h cap — unused capacity available`}>
                      <button
                        type="button"
                        onClick={() => setDrillDown({ wl, kind: 'ftUnder' })}
                        className="ml-1 font-semibold text-amber-600 hover:underline"
                      >
                        {ftUnder}
                      </button>
                    </HoverHint>{' '}under ·
                    {ftOff > 0 && (
                      <>
                        <HoverHint label={`Click to see the ${ftOff} full-time driver${ftOff === 1 ? '' : 's'} that didn't get scheduled this week`}>
                          <button
                            type="button"
                            onClick={() => setDrillDown({ wl, kind: 'ftOff' })}
                            className="ml-1 font-semibold text-slate-500 hover:underline"
                          >
                            {ftOff}
                          </button>
                        </HoverHint>{' '}off ·
                      </>
                    )}
                    <HoverHint label={`Click to see the ${ptAtCap + ptUnder} part-time driver${(ptAtCap + ptUnder) === 1 ? '' : 's'} scheduled this week (${ptAtCap} at ${schedule.partTimeCap}h cap, ${ptUnder} under)`}>
                      <button
                        type="button"
                        onClick={() => setDrillDown({ wl, kind: 'pt' })}
                        className="ml-1 font-semibold text-blue-600 hover:underline"
                      >
                        {ptAtCap + ptUnder}
                      </button>
                    </HoverHint>{' '}PT
                  </div>
                  {/* Days-off distribution pills — fairness at a glance.
                      Excludes shoppers (always work 6 non-Sundays). 1d-off
                      shown emerald (= "worked 6 days, fully used"); 2d-off
                      slate (normal); 3d-off and 4d+-off amber/red so under-
                      utilization is visually obvious. */}
                  <div className="flex items-center gap-1 text-xs">
                    {dayOffBuckets['1d'] > 0 && (
                      <HoverHint label={`Click to see the ${dayOffBuckets['1d']} driver${dayOffBuckets['1d'] === 1 ? '' : 's'} that worked 6 days this week (1 day off)`}>
                        <button
                          type="button"
                          onClick={() => setDrillDown({ wl, kind: '1d' })}
                          className="inline-flex items-center gap-0.5 rounded-full bg-emerald-100 px-2 py-0.5 font-semibold text-emerald-700 hover:bg-emerald-200"
                        >
                          {dayOffBuckets['1d']}
                          <span className="text-[10px] font-normal opacity-80">1d off</span>
                        </button>
                      </HoverHint>
                    )}
                    {dayOffBuckets['2d'] > 0 && (
                      <HoverHint label={`Click to see the ${dayOffBuckets['2d']} driver${dayOffBuckets['2d'] === 1 ? '' : 's'} that worked 5 days this week (2 days off)`}>
                        <button
                          type="button"
                          onClick={() => setDrillDown({ wl, kind: '2d' })}
                          className="inline-flex items-center gap-0.5 rounded-full bg-slate-100 px-2 py-0.5 font-semibold text-slate-700 hover:bg-slate-200"
                        >
                          {dayOffBuckets['2d']}
                          <span className="text-[10px] font-normal opacity-80">2d off</span>
                        </button>
                      </HoverHint>
                    )}
                    {dayOffBuckets['3d'] > 0 && (
                      <HoverHint label={`Click to see the ${dayOffBuckets['3d']} driver${dayOffBuckets['3d'] === 1 ? '' : 's'} that worked 4 days this week (3 days off) — under-utilized`}>
                        <button
                          type="button"
                          onClick={() => setDrillDown({ wl, kind: '3d' })}
                          className="inline-flex items-center gap-0.5 rounded-full bg-amber-100 px-2 py-0.5 font-semibold text-amber-700 hover:bg-amber-200"
                        >
                          {dayOffBuckets['3d']}
                          <span className="text-[10px] font-normal opacity-80">3d off</span>
                        </button>
                      </HoverHint>
                    )}
                    {dayOffBuckets['4d+'] > 0 && (
                      <HoverHint label={`Click to see the ${dayOffBuckets['4d+']} driver${dayOffBuckets['4d+'] === 1 ? '' : 's'} that worked 3 or fewer days this week (4+ days off) — heavily under-utilized`}>
                        <button
                          type="button"
                          onClick={() => setDrillDown({ wl, kind: '4d+' })}
                          className="inline-flex items-center gap-0.5 rounded-full bg-red-100 px-2 py-0.5 font-semibold text-red-700 hover:bg-red-200"
                        >
                          {dayOffBuckets['4d+']}
                          <span className="text-[10px] font-normal opacity-80">4+d off</span>
                        </button>
                      </HoverHint>
                    )}
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
                  {/* 10h-shift pill — dedicated counter so ops can spot the
                      Phase 9 morning-extension OT shifts (and any other 10h
                      shifts) at a glance and trim them manually if desired.
                      Same set as the daily-OT tally above (every dailyOtDays
                      shift is by definition >9h, almost always exactly 10h
                      under current rules). Click hint via tooltip. */}
                  {dailyOtDays > 0 && (
                    <span
                      // Red palette matches the per-shift "Hrs" cell pill
                      // in the day grid (DriverDayGrid renders >9h shifts
                      // with bg-red-100 text-red-700 ring-1 ring-red-400),
                      // so the two visual cues for the same shifts line up.
                      className="flex items-center gap-1 rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-semibold text-red-700 ring-1 ring-red-400"
                      title={`${dailyOtDays} shift${dailyOtDays === 1 ? '' : 's'} extended to 10h (legal daily overtime). Often produced by Phase 9 morning-extend to fill 8 AM gaps. Trim manually in the day grid if you want to bring them back to 9h.`}
                    >
                      {dailyOtDays}× 10h
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

            {/* Per-week headcount-limited banner — only renders when the
                40% floor couldn't be held on at least one priority slot in
                THIS week. Tucks just under the week header so the bad
                days are right above their day rows. */}
            <WeekHeadcountBanner
              slots={(schedule.headcountLimitedSlots ?? []).filter((s) => weekDateSet.has(s.date))}
            />

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
                    {dateInfo.date === nowDateISO && (
                      <span
                        className={clsx(
                          'rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white shadow-sm',
                          // Red tint when the current slot is below target so
                          // a coverage gap right NOW jumps out before the
                          // admin even expands the row.
                          nowCounts && nowCounts.actual < nowCounts.target
                            ? 'bg-red-600'
                            : 'bg-blue-600',
                        )}
                        title={
                          nowSlotIdx >= 0 && nowCounts
                            ? `Cayman local time. Right now: ${nowCounts.actual} driver${nowCounts.actual === 1 ? '' : 's'} working this slot vs target of ${nowCounts.target}${nowCounts.actual < nowCounts.target ? ` (short by ${nowCounts.target - nowCounts.actual})` : nowCounts.actual > nowCounts.target ? ` (+${nowCounts.actual - nowCounts.target} over)` : ' (at target)'}. Expand this row to see the live time-indicator line.`
                            : 'Today (Cayman local time). Operation is closed right now.'
                        }
                      >
                        {nowSlotIdx >= 0 ? nowLabel : 'TODAY · CLOSED'}
                      </span>
                    )}
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
                        // Only the day-card matching today's Cayman date
                        // AND only when we're inside ops hours gets the
                        // now-line. Every other card sees undefined →
                        // NowLine doesn't mount.
                        nowSlotIdx={
                          dateInfo.date === nowDateISO && nowSlotIdx >= 0
                            ? nowSlotIdx
                            : undefined
                        }
                        nowMinuteFrac={
                          dateInfo.date === nowDateISO && nowSlotIdx >= 0
                            ? nowMinuteFrac
                            : undefined
                        }
                        nowLabel={
                          dateInfo.date === nowDateISO && nowSlotIdx >= 0
                            ? nowLabel
                            : undefined
                        }
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

      <DriverAvailabilityModal
        open={!!editingAvailability}
        onClose={() => setEditingAvailability(null)}
        driverId={editingAvailability}
        minDate={startDate}
        maxDate={endDate}
      />

      {/* Drill-down modal — content computed from `drillDown` against the
          selected week's data. Closed state = null. Single instance at
          the bottom so we don't render 8 modals per week card. */}
      {(() => {
        if (!drillDown) return null
        const { wl, kind } = drillDown
        const weekDateSet = new Set(
          schedule.dates.filter((d) => d.weekLabel === wl).map((d) => d.date),
        )
        // Build the candidate row set: every driver scheduled this week
        // (or considered for it — FT off=0h drivers count too). Per-driver
        // metrics computed once, then filtered by `kind` below.
        const allRows: DrillDownRow[] = schedule.driverSchedules.map((ds) => {
          const hours = ds.weeklyHours[wl] ?? 0
          const isShopper = !!ds.driver.isShopper
          const cap = ds.driver.employmentType === 'full' ? fullTimeCap : schedule.partTimeCap
          let daysWorked = 0
          for (const e of ds.days) {
            if (!weekDateSet.has(e.date)) continue
            if (!e.isOff) daysWorked++
          }
          const daysOff = 7 - daysWorked
          return {
            id: ds.driver.id,
            name: ds.driver.name,
            employmentType: ds.driver.employmentType,
            isShopper,
            hours,
            cap,
            daysWorked,
            daysOff,
          }
        })
        // Filter to the requested bucket. The day-off buckets exclude
        // shoppers (they always work 6 non-Sundays — never the variable
        // ones ops cares about) AND exclude 0-day drivers (those are
        // "off all week", a separate bucket entirely).
        let rows: DrillDownRow[] = []
        let title = ''
        let subtitle: string | undefined = wl
        if (kind === 'ftAtCap') {
          rows = allRows.filter((r) => r.employmentType === 'full' && !r.isShopper && r.hours >= fullTimeCap)
          title = `Full-time drivers at ${fullTimeCap}h cap`
        } else if (kind === 'ftUnder') {
          rows = allRows.filter((r) => r.employmentType === 'full' && !r.isShopper && r.hours > 0 && r.hours < fullTimeCap)
          title = `Full-time drivers under ${fullTimeCap}h cap`
          subtitle = `${wl} · unused capacity`
        } else if (kind === 'ftOff') {
          rows = allRows.filter((r) => r.employmentType === 'full' && !r.isShopper && r.hours === 0)
          title = 'Full-time drivers fully off this week'
        } else if (kind === 'pt') {
          rows = allRows.filter((r) => r.employmentType === 'part')
          title = `Part-time drivers (${schedule.partTimeCap}h cap)`
        } else {
          // Day-off buckets: 1d/2d/3d/4d+, excluding shoppers and 0-day drivers.
          const wantedOff = (n: number) =>
            kind === '4d+' ? n >= 4 : kind === '3d' ? n === 3 : kind === '2d' ? n === 2 : n === 1
          rows = allRows.filter((r) => !r.isShopper && r.daysWorked > 0 && wantedOff(r.daysOff))
          const label = kind === '4d+' ? '4+ days off' : `${kind === '1d' ? '1' : kind === '2d' ? '2' : '3'} day${kind === '1d' ? '' : 's'} off`
          title = `Drivers with ${label}`
          subtitle = `${wl} · ${kind === '1d' ? '6 days worked' : kind === '2d' ? '5 days worked' : kind === '3d' ? '4 days worked' : '3 or fewer days worked'}`
        }
        return (
          <DriverDrillDownModal
            open={true}
            onClose={() => setDrillDown(null)}
            title={title}
            subtitle={subtitle}
            rows={rows}
            onEditDriver={(id) => setEditingAvailability(id)}
          />
        )
      })()}
    </div>
  )
}
