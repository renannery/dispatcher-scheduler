import clsx from 'clsx'
import { ChevronDown, ChevronRight, Download, FileJson, FileText, Loader2, Redo2, RefreshCw, Search, Shield, Shuffle, Undo2, Users, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { DAY_TEMPLATES, SLOTS } from '@/data/coverageTemplate'
import { useSchedulerStore } from '@/store/schedulerStore'
import { generateSchedule, hoursStatusBg, hoursStatusColor } from '@/utils/scheduler'
import { caymanNow, caymanTimeLabel } from '@/utils/caymanTime'
import { downloadSnapshot, SCHEMA_VERSION } from '@/utils/snapshot'
import { exportScheduleToXLS } from '@/utils/xlsExporter'
import { DateRangePicker } from '@/components/DateRangePicker'
import { DayGrid } from './DayGrid'

// Per-slot start times (in minutes from midnight) computed from the SLOTS
// definition — ops day opens at 8 AM. Mirrors the driver-side calculation
// but accounts for dispatchers' mixed 0.5h/1h slot granularity.
const OPS_OPEN_MIN = 8 * 60
const SLOT_START_MIN = (() => {
  let cum = OPS_OPEN_MIN
  const out: number[] = []
  for (const s of SLOTS) { out.push(cum); cum += s.hours * 60 }
  return out
})()
const OPS_CLOSE_MIN = SLOT_START_MIN[SLOTS.length - 1] + SLOTS[SLOTS.length - 1].hours * 60

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
  const { schedule, dispatchers, startDate, endDate, timeOff, absenceReasons, weekendRotationOffset, coverageOverrides, setSchedule, applyShuffledSchedule, undoScheduleEdit, redoScheduleEdit, setStep, setDateRange } =
    useSchedulerStore()
  // Track undo/redo button enabled state. Subscribe via stack lengths so the
  // component re-renders the moment toggle changes them.
  const undoCount = useSchedulerStore((s) => s.scheduleUndoStack.length)
  const redoCount = useSchedulerStore((s) => s.scheduleRedoStack.length)
  const canUndo = undoCount > 0
  const canRedo = redoCount > 0
  const [expandedDates, setExpandedDates] = useState<Set<string>>(new Set())
  const [pdfLoading, setPdfLoading] = useState(false)
  const [showAllPills, setShowAllPills] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')
  // Drill-down modal: click any hour-summary or days-off pill to see the
  // filtered dispatcher list for that bucket.
  type DrillKind = 'atCap' | 'target' | 'under' | 'off' | '1d' | '2d' | '3d' | '4d+'
  const [drillDown, setDrillDown] = useState<null | { wl: string; kind: DrillKind }>(null)
  // Forces a re-render every wall-clock minute so the NowLine slides.
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

  // Per-minute tick that drives the current-time indicator. Aligning the
  // first interval to the next wall-clock minute boundary makes the line
  // jump exactly when the minute changes (not e.g. 47s late).
  // Note: state hook lives outside this block — see useNowTick below.
  void nowTick

  // Today + slot/fraction within the dispatcher slot layout. -1 when
  // outside ops hours (before 8 AM / after 11 PM) → no NowLine on any day.
  const _now = caymanNow()
  const nowMinOfDay = _now.hours * 60 + _now.minutes
  const nowDateISO = _now.dateISO
  const insideOps = nowMinOfDay >= OPS_OPEN_MIN && nowMinOfDay < OPS_CLOSE_MIN
  const nowSlotIdx = insideOps
    ? SLOT_START_MIN.findIndex((start, i) => start <= nowMinOfDay && nowMinOfDay < start + SLOTS[i].hours * 60)
    : -1
  const nowMinuteFrac = nowSlotIdx >= 0
    ? (nowMinOfDay - SLOT_START_MIN[nowSlotIdx]) / (SLOTS[nowSlotIdx].hours * 60)
    : 0
  const nowLabel = `NOW · ${caymanTimeLabel()}`

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
    const fresh = generateSchedule(dispatchers, startDate, endDate, timeOff, weekendRotationOffset + regenSeed.current, coverageOverrides)
    setSchedule(fresh)
    setExpandedDates(new Set())
  }
  // Shuffle = re-roll with a new seed but keep undo history so Cmd+Z
  // brings the previous shuffle back. Different from Regenerate which
  // clears the stacks (treated as a fresh start).
  const handleShuffle = () => {
    regenSeed.current++
    const shuffled = generateSchedule(dispatchers, startDate, endDate, timeOff, weekendRotationOffset + regenSeed.current, coverageOverrides)
    applyShuffledSchedule(shuffled)
  }

  // Date-range change: re-run the generator for the new window. Loses any
  // manual edits to the prior schedule (we don't have a slide helper for
  // dispatchers yet) — Cmd+Z brings the previous schedule back.
  const handleDateRangeChange = (start: string, end: string) => {
    if (start === startDate && end === endDate) return
    setDateRange(start, end)
    const fresh = generateSchedule(dispatchers, start, end, timeOff, weekendRotationOffset + regenSeed.current, coverageOverrides)
    setSchedule(fresh)
    setExpandedDates(new Set())
  }

  // Keyboard: Cmd/Ctrl+Z = undo, Cmd/Ctrl+Shift+Z (or Y) = redo. Skips
  // when focus is inside an editable element so user text-input isn't
  // hijacked.
  useEffect(() => {
    const isEditable = (el: EventTarget | null) => {
      if (!(el instanceof HTMLElement)) return false
      if (el.isContentEditable) return true
      const tag = el.tagName
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
    }
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      if (isEditable(e.target)) return
      const key = e.key.toLowerCase()
      if (key === 'z' && !e.shiftKey) { e.preventDefault(); undoScheduleEdit() }
      else if ((key === 'z' && e.shiftKey) || key === 'y') { e.preventDefault(); redoScheduleEdit() }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [undoScheduleEdit, redoScheduleEdit])

  const handleExportJson = () => {
    downloadSnapshot({
      version: SCHEMA_VERSION,
      team: 'dispatchers',
      exportedAt: new Date().toISOString(),
      data: { dispatchers, startDate, endDate, timeOff, absenceReasons, weekendRotationOffset, coverageOverrides, schedule },
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

  // Weekend-rotation feasibility: for everyone to cycle through one Fri,
  // one Sat, and one Sun off, you need (N * 3) / weekend-off-slots-per-week
  // weeks of schedule. With N dispatchers and X patterns needed per weekend
  // day, off-slots per weekend day = max(0, N - X). Aggregated over 3 days
  // gives off-slots per week; ideal weeks = ceil(3N / off-slots-per-week).
  const N = dispatchers.length
  const friPatterns = DAY_TEMPLATES[5]?.shiftPatterns.length ?? 0
  const satPatterns = DAY_TEMPLATES[6]?.shiftPatterns.length ?? 0
  const sunPatterns = DAY_TEMPLATES[0]?.shiftPatterns.length ?? 0
  const weekendOffSlotsPerWeek =
    Math.max(0, N - friPatterns) +
    Math.max(0, N - satPatterns) +
    Math.max(0, N - sunPatterns)
  const idealRotationWeeks = weekendOffSlotsPerWeek > 0
    ? Math.ceil((N * 3) / weekendOffSlotsPerWeek)
    : Infinity
  const currentWeeks = weekLabels.length
  const rotationShort = currentWeeks < idealRotationWeeks
  const rosterTooSmall = !Number.isFinite(idealRotationWeeks)

  return (
    <div className="flex flex-col gap-6">
      {/* Weekend-rotation period banner — surfaced when the current
          schedule is shorter than the math requires for everyone to cycle
          through one Fri + one Sat + one Sun off. Goes away once the
          period is long enough; shows a hire-more message when the
          roster itself is too small to leave anyone off on weekends. */}
      {(rotationShort || rosterTooSmall) && (
        <div className="flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-5 py-3 text-sm text-amber-800 shadow-sm">
          <span className="mt-0.5 shrink-0 text-base">💡</span>
          <div className="flex-1">
            {rosterTooSmall ? (
              <>
                <span className="font-semibold">Roster too small for weekend rotation.</span>{' '}
                With {N} dispatcher{N === 1 ? '' : 's'} and {Math.max(friPatterns, satPatterns, sunPatterns)} needed on each weekend day, nobody can get a weekend off. Hire more dispatchers (or lower weekend coverage targets) to unlock the rotation.
              </>
            ) : (
              <>
                <span className="font-semibold">Generate a {idealRotationWeeks}-week period for a full weekend rotation.</span>{' '}
                With {N} dispatchers and {weekendOffSlotsPerWeek} weekend off-slot{weekendOffSlotsPerWeek === 1 ? '' : 's'} per week, it takes {idealRotationWeeks} weeks for everyone to get one Fri, one Sat, and one Sun off. You're currently on a {currentWeeks}-week period — extend the dates above to get the full cycle.
              </>
            )}
          </div>
        </div>
      )}

      {/* Action bar */}
      <div className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white px-5 py-4 shadow-sm">
        {/* Schedule period — change dates inline; re-runs the generator
            (Cmd+Z reverts). Dispatcher count next to it for quick context. */}
        <div className="flex flex-wrap items-end gap-x-5 gap-y-2">
          <DateRangePicker
            startDate={startDate}
            endDate={endDate}
            onChange={handleDateRangeChange}
            label="Schedule period"
            compact
            showStats
          />
          <div className="pb-1 text-xs text-slate-500">
            <span className="font-semibold text-slate-700">{dispatchers.length}</span> dispatchers
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-4">
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
        <div className="flex flex-wrap gap-2">
          {/* Undo / Redo — only enabled when there's something on the stack.
              Keyboard shortcuts: Cmd/Ctrl+Z and Cmd/Ctrl+Shift+Z (or Y). */}
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
            onClick={handleShuffle}
            title="Re-roll the schedule with a new rotation seed — same dispatchers, different pairings. Cmd+Z to undo."
            className="flex items-center gap-2 rounded-xl border border-indigo-300 bg-indigo-50 px-4 py-2 text-sm font-medium text-indigo-700 transition hover:bg-indigo-100"
          >
            <Shuffle className="h-4 w-4" />
            Shuffle
          </button>
          <button
            onClick={handleRegenerate}
            title="Regenerate from scratch — clears undo history"
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
        const weekDateSet = new Set(weekDates.map((d) => d.date))

        const weekHoursSummary = schedule.dispatcherSchedules.map((ds) => {
          const off = ds.days.filter((d) => weekDateSet.has(d.date) && d.isOff).length
          return {
            name:  ds.dispatcher.name,
            hours: ds.weeklyHours[wl] ?? 0,
            off,
          }
        })

        // Aggregate summary
        const allHours = weekHoursSummary.map((s) => s.hours)
        const atCap = allHours.filter((h) => h >= 45).length
        const under = allHours.filter((h) => h > 0 && h < 36).length
        const target = allHours.filter((h) => h >= 36 && h < 45).length
        const offCount = allHours.filter((h) => h === 0).length

        // Days-off distribution buckets (skip dispatchers who didn't work at
        // all this week — those are blocked / on leave, not under-utilized).
        // Semantics tuned for dispatchers: 2 days off is the target (emerald),
        // 1 day off is the shortfall week (amber), 3+ days off is under-used.
        const dayOffBuckets = { '1d': 0, '2d': 0, '3d': 0, '4d+': 0 }
        for (const d of weekHoursSummary) {
          if (d.hours === 0) continue
          if (d.off === 1) dayOffBuckets['1d']++
          else if (d.off === 2) dayOffBuckets['2d']++
          else if (d.off === 3) dayOffBuckets['3d']++
          else if (d.off >= 4) dayOffBuckets['4d+']++
        }

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
                    <button
                      type="button"
                      onClick={() => atCap > 0 && setDrillDown({ wl, kind: 'atCap' })}
                      disabled={atCap === 0}
                      title={atCap > 0 ? 'Click to see dispatchers at the 45 h legal cap' : 'No dispatchers at cap'}
                      className="font-semibold text-emerald-600 disabled:text-slate-300 enabled:hover:underline"
                    >{atCap}</button> at 45h ·
                    <button
                      type="button"
                      onClick={() => target > 0 && setDrillDown({ wl, kind: 'target' })}
                      disabled={target === 0}
                      title={target > 0 ? 'Click to see dispatchers in the 36–44 h target band' : 'No dispatchers in 36–44 h'}
                      className="ml-1 font-semibold text-emerald-600 disabled:text-slate-300 enabled:hover:underline"
                    >{target}</button> 36–44h ·
                    <button
                      type="button"
                      onClick={() => under > 0 && setDrillDown({ wl, kind: 'under' })}
                      disabled={under === 0}
                      title={under > 0 ? 'Click to see dispatchers under 36 h' : 'No dispatchers under 36 h'}
                      className="ml-1 font-semibold text-amber-600 disabled:text-slate-300 enabled:hover:underline"
                    >{under}</button> under
                    {offCount > 0 && (
                      <>
                        <span className="ml-1">·</span>
                        <button
                          type="button"
                          onClick={() => setDrillDown({ wl, kind: 'off' })}
                          title="Click to see dispatchers fully off this week"
                          className="ml-1 font-semibold text-slate-500 hover:underline"
                        >{offCount}</button> off
                      </>
                    )}
                  </div>
                  {/* Days-off pills — clickable to open drill-down modal.
                      2d off = target (emerald), 1d off = shortfall (amber),
                      3+d off = under-utilized. */}
                  <div className="flex items-center gap-1 text-xs">
                    {dayOffBuckets['1d'] > 0 && (
                      <button
                        type="button"
                        onClick={() => setDrillDown({ wl, kind: '1d' })}
                        title={`Click to see the ${dayOffBuckets['1d']} dispatcher${dayOffBuckets['1d'] === 1 ? '' : 's'} that worked 6 days this week (1 day off — shortfall)`}
                        className="inline-flex items-center gap-0.5 rounded-full bg-amber-100 px-2 py-0.5 font-semibold text-amber-700 hover:bg-amber-200"
                      >
                        {dayOffBuckets['1d']}
                        <span className="text-[10px] font-normal opacity-80">1d off</span>
                      </button>
                    )}
                    {dayOffBuckets['2d'] > 0 && (
                      <button
                        type="button"
                        onClick={() => setDrillDown({ wl, kind: '2d' })}
                        title={`Click to see the ${dayOffBuckets['2d']} dispatcher${dayOffBuckets['2d'] === 1 ? '' : 's'} that got 2 days off this week (target)`}
                        className="inline-flex items-center gap-0.5 rounded-full bg-emerald-100 px-2 py-0.5 font-semibold text-emerald-700 hover:bg-emerald-200"
                      >
                        {dayOffBuckets['2d']}
                        <span className="text-[10px] font-normal opacity-80">2d off</span>
                      </button>
                    )}
                    {dayOffBuckets['3d'] > 0 && (
                      <button
                        type="button"
                        onClick={() => setDrillDown({ wl, kind: '3d' })}
                        title={`Click to see the ${dayOffBuckets['3d']} dispatcher${dayOffBuckets['3d'] === 1 ? '' : 's'} that worked 4 days this week (3 days off — under-utilized)`}
                        className="inline-flex items-center gap-0.5 rounded-full bg-amber-100 px-2 py-0.5 font-semibold text-amber-700 hover:bg-amber-200"
                      >
                        {dayOffBuckets['3d']}
                        <span className="text-[10px] font-normal opacity-80">3d off</span>
                      </button>
                    )}
                    {dayOffBuckets['4d+'] > 0 && (
                      <button
                        type="button"
                        onClick={() => setDrillDown({ wl, kind: '4d+' })}
                        title={`Click to see the ${dayOffBuckets['4d+']} dispatcher${dayOffBuckets['4d+'] === 1 ? '' : 's'} that worked 3 or fewer days this week (4+ days off — heavily under-utilized)`}
                        className="inline-flex items-center gap-0.5 rounded-full bg-red-100 px-2 py-0.5 font-semibold text-red-700 hover:bg-red-200"
                      >
                        {dayOffBuckets['4d+']}
                        <span className="text-[10px] font-normal opacity-80">4+d off</span>
                      </button>
                    )}
                  </div>
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
              const required = schedule.coverageRequired?.[dateInfo.date]
                ?? DAY_TEMPLATES[dateInfo.dayOfWeek]?.requiredCoverage
                ?? []
              // Count short slots + total deficit hours (deficit weighted by
              // slot length so a 1 h shortfall counts more than a 0.5 h one).
              let gapCount = 0
              let gapHours = 0
              for (let i = 0; i < required.length; i++) {
                const deficit = required[i] - (actual[i] ?? 0)
                if (deficit > 0) {
                  gapCount++
                  gapHours += deficit * SLOTS[i].hours
                }
              }
              const hasGap = gapCount > 0

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
                      <span
                        className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-600"
                        title={`${gapCount} slot${gapCount === 1 ? '' : 's'} under target — total deficit ${gapHours.toFixed(1)}h across the day`}
                      >
                        ⚠ {gapCount} gap{gapCount === 1 ? '' : 's'} ({gapHours.toFixed(gapHours % 1 === 0 ? 0 : 1)}h)
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
                        nowSlotIdx={dateInfo.date === nowDateISO && nowSlotIdx >= 0 ? nowSlotIdx : undefined}
                        nowMinuteFrac={dateInfo.date === nowDateISO && nowSlotIdx >= 0 ? nowMinuteFrac : undefined}
                        nowLabel={dateInfo.date === nowDateISO && nowSlotIdx >= 0 ? nowLabel : undefined}
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
            title="Download a snapshot of the current schedule (roster, settings, all shifts). Reload it later to pick up exactly where you left off."
            className="flex items-center gap-2 rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
          >
            <FileJson className="h-4 w-4" />
            Snapshot
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

      {/* Drill-down modal — opens when a week's stat or days-off pill is
          clicked. Computes filtered rows from `drillDown.kind` against the
          week's data. Single instance at the bottom (no per-week duplicates). */}
      {(() => {
        if (!drillDown) return null
        const { wl, kind } = drillDown
        const weekDates = schedule.dates.filter((d) => d.weekLabel === wl)
        const weekDateSet = new Set(weekDates.map((d) => d.date))
        // Short weekday label per date, e.g. "Thu" — derived from dayLabel
        // which is formatted as "Thu, June 25th".
        const dateToShort = new Map(
          weekDates.map((d) => [d.date, d.dayLabel.split(',')[0]] as const),
        )
        type Row = {
          id: string; name: string; level: string; color: string
          hours: number; daysWorked: number; daysOff: number; offLabels: string[]
        }
        const allRows: Row[] = schedule.dispatcherSchedules.map((ds) => {
          const hours = ds.weeklyHours[wl] ?? 0
          let daysWorked = 0
          const offLabels: string[] = []
          for (const e of ds.days) {
            if (!weekDateSet.has(e.date)) continue
            if (e.isOff) offLabels.push(dateToShort.get(e.date) ?? '')
            else daysWorked++
          }
          return {
            id: ds.dispatcher.id,
            name: ds.dispatcher.name,
            level: ds.dispatcher.level,
            color: ds.dispatcher.color,
            hours,
            daysWorked,
            daysOff: 7 - daysWorked,
            offLabels,
          }
        })
        let rows: Row[] = []
        let title = ''
        let subtitle: string = wl
        if (kind === 'atCap') {
          rows = allRows.filter((r) => r.hours >= 45)
          title = 'Dispatchers at the 45 h legal cap'
        } else if (kind === 'target') {
          rows = allRows.filter((r) => r.hours >= 36 && r.hours < 45)
          title = 'Dispatchers in the 36–44 h target band'
        } else if (kind === 'under') {
          rows = allRows.filter((r) => r.hours > 0 && r.hours < 36)
          title = 'Dispatchers under 36 h'
          subtitle = `${wl} · unused capacity`
        } else if (kind === 'off') {
          rows = allRows.filter((r) => r.hours === 0)
          title = 'Dispatchers fully off this week'
        } else {
          const wanted = kind === '4d+' ? (n: number) => n >= 4
            : kind === '3d' ? (n: number) => n === 3
            : kind === '2d' ? (n: number) => n === 2
            : (n: number) => n === 1
          rows = allRows.filter((r) => r.hours > 0 && wanted(r.daysOff))
          const label = kind === '4d+' ? '4+ days off'
            : `${kind === '1d' ? '1' : kind === '2d' ? '2' : '3'} day${kind === '1d' ? '' : 's'} off`
          title = `Dispatchers with ${label}`
          subtitle = `${wl} · ${kind === '1d' ? '6 days worked' : kind === '2d' ? '5 days worked' : kind === '3d' ? '4 days worked' : '3 or fewer days worked'}`
        }
        const sorted = [...rows].sort((a, b) => b.hours - a.hours)
        return (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/30 px-4"
            onClick={() => setDrillDown(null)}
          >
            <div
              className="flex max-h-[80vh] w-full max-w-md flex-col rounded-2xl bg-white shadow-xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-3">
                <div className="min-w-0">
                  <h3 className="truncate text-base font-semibold text-slate-800">{title}</h3>
                  <p className="mt-0.5 truncate text-xs text-slate-500">{subtitle}</p>
                </div>
                <button
                  type="button"
                  onClick={() => setDrillDown(null)}
                  className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                  aria-label="Close"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto px-5 py-3">
                {sorted.length === 0 ? (
                  <p className="py-6 text-center text-sm text-slate-400">No dispatchers match.</p>
                ) : (
                  <ul className="flex flex-col divide-y divide-slate-100">
                    {sorted.map((r) => (
                      <li key={r.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: r.color }} />
                            <span className="truncate font-semibold text-slate-800">{r.name.split(' ')[0]}</span>
                            <span className={clsx(
                              'rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase',
                              r.level === 'Senior' ? 'bg-amber-100 text-amber-700' :
                              r.level === 'Regular' ? 'bg-blue-100 text-blue-700' :
                              'bg-slate-100 text-slate-600',
                            )}>
                              {r.level === 'Senior' ? 'SR' : r.level === 'Regular' ? 'RG' : 'TR'}
                            </span>
                          </div>
                          <div className="mt-0.5 text-xs text-slate-500">
                            {r.daysWorked} day{r.daysWorked === 1 ? '' : 's'} worked · {r.daysOff} day{r.daysOff === 1 ? '' : 's'} off
                            {r.offLabels.length > 0 && ` (${r.offLabels.join(', ')})`}
                          </div>
                        </div>
                        <div className={clsx('rounded-full border px-2 py-0.5 text-xs font-semibold tabular-nums', hoursStatusBg(r.hours))}>
                          {r.hours.toFixed(1)}h
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="border-t border-slate-100 px-5 py-2 text-xs text-slate-500">
                {sorted.length} dispatcher{sorted.length === 1 ? '' : 's'} in this bucket
              </div>
            </div>
          </div>
        )
      })()}
    </div>
  )
}
