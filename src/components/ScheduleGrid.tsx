import clsx from 'clsx'
import { CalendarCheck2, ChevronDown, ChevronRight, Download, FileJson, FileText, Loader2, Redo2, RefreshCw, ScrollText, Search, Shield, Shuffle, Undo2, Users, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { DAY_TEMPLATES, SLOTS } from '@/data/coverageTemplate'
import { useSchedulerStore } from '@/store/schedulerStore'
import { generateSchedule, hoursStatusBg, hoursStatusColor, shuffleDispatcherAssignments } from '@/utils/scheduler'
import { caymanNow, caymanTimeLabel } from '@/utils/caymanTime'
import { downloadSnapshot, SCHEMA_VERSION } from '@/utils/snapshot'
import { exportScheduleToXLS } from '@/utils/xlsExporter'
import { DateRangePicker } from '@/components/DateRangePicker'
import { SavedScheduleBadge } from '@/components/SavedScheduleBadge'
import { useIsAdmin } from '@/store/adminStore'
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
  | { type: 'individual-compact'; dispatcherId: string; name: string }

interface PdfMenuProps {
  dispatchers: { id: string; name: string; color: string }[]
  loading: boolean
  onSelect: (action: PdfAction) => void
  /** Non-admin mode shows only individual options (no Admin/Team). */
  individualOnly?: boolean
}

function PdfMenu({ dispatchers, loading, onSelect, individualOnly }: PdfMenuProps) {
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
        <div className="absolute right-0 top-full z-30 mt-1.5 max-h-[80vh] w-60 overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-lg">
          {/* Admin + Team — admin-only */}
          {!individualOnly && (
            <>
              <button
                onClick={() => pick({ type: 'admin' })}
                className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm transition hover:bg-slate-50"
              >
                <Shield className="h-4 w-4 text-blue-600 shrink-0" />
                <div>
                  <div className="font-semibold text-slate-800">Admin</div>
                  <div className="text-xs text-slate-400">All dispatchers + hours + coverage</div>
                </div>
              </button>
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
              <div className="mx-4 border-t border-slate-100 my-1" />
            </>
          )}

          <div className="px-4 py-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
            {individualOnly ? 'Your schedule' : 'Individual'}
          </div>

          {dispatchers.map((d) => (
            <div key={d.id} className="flex items-stretch border-b border-slate-50 last:border-0">
              <button
                onClick={() => pick({ type: 'individual', dispatcherId: d.id, name: d.name })}
                className="flex flex-1 items-center gap-3 px-4 py-2 text-left text-sm transition hover:bg-slate-50"
                title="Full schedule (letter size)"
              >
                <div
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[9px] font-bold text-white"
                  style={{ backgroundColor: d.color }}
                >
                  {d.name.split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase()}
                </div>
                <span className="text-slate-700">{d.name}</span>
              </button>
              <button
                onClick={() => pick({ type: 'individual-compact', dispatcherId: d.id, name: d.name })}
                title="Phone-friendly compact version"
                className="flex items-center gap-1 px-2.5 text-[10px] font-bold text-violet-700 hover:bg-violet-50"
              >
                📱
              </button>
            </div>
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
  const { schedule, dispatchers, startDate, endDate, timeOff, absenceReasons, weekendRotationOffset, secondOffRotationOffset, coverageOverrides, setSchedule, applyShuffledSchedule, undoScheduleEdit, redoScheduleEdit, setStep, setDateRange } =
    useSchedulerStore()
  const isAdmin = useIsAdmin()
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
  type DrillKind = 'atCap' | 'target' | 'under' | 'off' | '0d' | '1d' | '2d' | '3d' | '4d+'
  const [drillDown, setDrillDown] = useState<null | { wl: string; kind: DrillKind }>(null)
  // Per-dispatcher detail modal — fired from a peak-wk pill click.
  const [dispatcherDetailId, setDispatcherDetailId] = useState<string | null>(null)
  // "See Rules Applied" modal — static hard rules + per-week 2nd-day-off log.
  const [rulesOpen, setRulesOpen] = useState(false)
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
  // outside ops hours (before 8 AM / after 11:30 PM) → no NowLine on any day.
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
    const fresh = generateSchedule(dispatchers, startDate, endDate, timeOff, weekendRotationOffset + regenSeed.current, coverageOverrides, secondOffRotationOffset)
    setSchedule(fresh)
    setExpandedDates(new Set())
  }
  // Shuffle = rotate which dispatcher takes which shift on each day
  // while keeping the per-day shift shapes IDENTICAL. Same coverage,
  // same off-days per person — just different people in each role.
  // Cmd+Z brings the previous arrangement back.
  const handleShuffle = () => {
    regenSeed.current++
    const shuffled = shuffleDispatcherAssignments(schedule, timeOff, regenSeed.current)
    applyShuffledSchedule(shuffled)
  }

  // Date-range change: re-run the generator for the new window. Loses any
  // manual edits to the prior schedule (we don't have a slide helper for
  // dispatchers yet) — Cmd+Z brings the previous schedule back.
  const handleDateRangeChange = (start: string, end: string) => {
    if (start === startDate && end === endDate) return
    setDateRange(start, end)
    const fresh = generateSchedule(dispatchers, start, end, timeOff, weekendRotationOffset + regenSeed.current, coverageOverrides, secondOffRotationOffset)
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
      data: { dispatchers, startDate, endDate, timeOff, absenceReasons, weekendRotationOffset, secondOffRotationOffset, coverageOverrides, schedule },
    })
  }

  const handlePdfSelect = async (action: PdfAction) => {
    setPdfLoading(true)
    try {
      const mod = await import('@/utils/pdfExporter')
      // Non-admin users never see total hours in their PDF —
      // matches the on-screen rule (admin PIN required to view hours).
      const hideHours = !isAdmin
      if (action.type === 'admin')              await mod.exportAdminPDF(schedule)
      if (action.type === 'team')               await mod.exportTeamPDF(schedule)
      if (action.type === 'individual')         await mod.exportIndividualPDF(schedule, action.dispatcherId, hideHours)
      if (action.type === 'individual-compact') await mod.exportIndividualCompactPDF(schedule, action.dispatcherId, hideHours)
    } finally {
      setPdfLoading(false)
    }
  }

  // Peak weekly hours per dispatcher for the action bar.
  const totalsByPerson = schedule.dispatcherSchedules.map((ds) => ({
    id:    ds.dispatcher.id,
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
          roster itself is too small to leave anyone off on weekends.
          Admin-only — non-admins can't act on it (no period control). */}
      {isAdmin && (rotationShort || rosterTooSmall) && (
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
        {/* Saved-version pill + Save button — backed by a GitHub Gist
            (docs/cloud-setup.md), hidden entirely when env vars aren't set.
            Sits at the top of the bar so the user always sees which
            version is live in the shared store. */}
        {isAdmin && (
          <div className="flex flex-wrap items-center gap-2">
            <SavedScheduleBadge
              team="dispatchers"
              collectSnapshot={() => ({
                dispatchers, startDate, endDate, timeOff, absenceReasons,
                weekendRotationOffset, secondOffRotationOffset, coverageOverrides, schedule,
              })}
            />
          </div>
        )}
        {/* Schedule period — change dates inline; re-runs the generator
            (Cmd+Z reverts). Dispatcher count next to it for quick context.
            Date picker is admin-only (editing dates is an edit action). */}
        <div className="flex flex-wrap items-end gap-x-5 gap-y-2">
          {isAdmin ? (
            <DateRangePicker
              startDate={startDate}
              endDate={endDate}
              onChange={handleDateRangeChange}
              label="Schedule period"
              compact
              showStats
            />
          ) : (
            <div className="text-sm font-medium text-slate-700">
              Schedule period:{' '}
              <span className="font-semibold">
                {startDate} → {endDate}
              </span>
            </div>
          )}
          <div className="pb-1 text-xs text-slate-500">
            <span className="font-semibold text-slate-700">{dispatchers.length}</span> dispatchers
          </div>
        </div>
        {isAdmin && (
        <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-xs font-medium text-slate-400 uppercase tracking-wide">peak wk</span>
          {totalsByPerson.map(({ id, name, hours, color }) => (
            <button
              key={id}
              type="button"
              onClick={() => setDispatcherDetailId(id)}
              className="flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-sm transition hover:bg-slate-100"
              title={`${name}: click for details`}
            >
              <div className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: color }} />
              <span className="font-medium text-slate-700">{name.split(' ')[0]}</span>
              <span className={clsx('font-bold', hoursStatusColor(hours))}>{hours.toFixed(1)}h</span>
            </button>
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
            onClick={() => setRulesOpen(true)}
            title="See the scheduling rules this schedule was built under, plus the week-by-week rotating 2nd-day-off decisions."
            className="flex items-center gap-2 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
          >
            <ScrollText className="h-4 w-4" />
            Rules
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
        )}
        {/* Non-admin: still let dispatchers grab their own PDF. */}
        {!isAdmin && (
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setRulesOpen(true)}
              title="See the scheduling rules this schedule was built under, plus the week-by-week rotating 2nd-day-off decisions."
              className="flex items-center gap-2 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
            >
              <ScrollText className="h-4 w-4" />
              Rules
            </button>
            <PdfMenu
              dispatchers={dispatchers}
              loading={pdfLoading}
              onSelect={handlePdfSelect}
              individualOnly
            />
          </div>
        )}
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
        // 0 days off is a mandatory-weekly-rest VIOLATION (red) — the
        // current scheduler can't produce it, so it flags hand edits or a
        // schedule generated before the rest rule existed (regenerate!).
        const dayOffBuckets = { '0d': 0, '1d': 0, '2d': 0, '3d': 0, '4d+': 0 }
        const isFullWeek = weekDates.length === 7
        for (const d of weekHoursSummary) {
          if (d.hours === 0) continue
          // Partial edge weeks can legitimately have 0 offs (someone
          // working a 2-day stub week) — only full weeks violate.
          if (d.off === 0) { if (isFullWeek) dayOffBuckets['0d']++ }
          else if (d.off === 1) dayOffBuckets['1d']++
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
                  {isAdmin && (
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
                  )}
                  {/* Days-off pills — clickable to open drill-down modal.
                      2d off = target (emerald), 1d off = shortfall (amber),
                      3+d off = under-utilized. Hidden for non-admins. */}
                  {isAdmin && (
                  <div className="flex items-center gap-1 text-xs">
                    {dayOffBuckets['0d'] > 0 && (
                      <button
                        type="button"
                        onClick={() => setDrillDown({ wl, kind: '0d' })}
                        title={`Click to see the ${dayOffBuckets['0d']} dispatcher${dayOffBuckets['0d'] === 1 ? '' : 's'} with NO day off this week — violates the mandatory weekly rest. Regenerate the schedule to fix.`}
                        className="inline-flex items-center gap-0.5 rounded-full bg-red-600 px-2 py-0.5 font-semibold text-white ring-2 ring-red-200 hover:bg-red-700"
                      >
                        {dayOffBuckets['0d']}
                        <span className="text-[10px] font-normal opacity-90">× 0d off ⚠</span>
                      </button>
                    )}
                    {dayOffBuckets['1d'] > 0 && (
                      <button
                        type="button"
                        onClick={() => setDrillDown({ wl, kind: '1d' })}
                        title={`Click to see the ${dayOffBuckets['1d']} dispatcher${dayOffBuckets['1d'] === 1 ? '' : 's'} that worked 6 days this week (1 day off — shortfall)`}
                        className="inline-flex items-center gap-0.5 rounded-full bg-amber-100 px-2 py-0.5 font-semibold text-amber-700 hover:bg-amber-200"
                      >
                        {dayOffBuckets['1d']}
                        <span className="text-[10px] font-normal opacity-80">× 1d off</span>
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
                        <span className="text-[10px] font-normal opacity-80">× 2d off</span>
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
                        <span className="text-[10px] font-normal opacity-80">× 3d off</span>
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
                        <span className="text-[10px] font-normal opacity-80">× 4+d off</span>
                      </button>
                    )}
                  </div>
                  )}
                </div>
                <div className="flex shrink-0 gap-2 text-xs text-slate-400">
                  {isAdmin && (
                    <>
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
                    </>
                  )}
                  <button onClick={expandAll}  className="hover:text-blue-600">expand all</button>
                  <span>·</span>
                  <button onClick={collapseAll} className="hover:text-blue-600">collapse</button>
                </div>
              </div>
              {isAdmin && pillsExpanded && (
                <div className="flex flex-wrap gap-1.5">
                  {filteredPills.length === 0 && (
                    <span className="text-xs text-slate-400">No dispatchers match &quot;{trimmedSearch}&quot;.</span>
                  )}
                  {filteredPills.map(({ name, hours }) => (
                    <span
                      key={name}
                      className={clsx(
                        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold',
                        hoursStatusBg(hours),
                      )}
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
                    {isAdmin && hasGap && (
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
      {/* Bottom nav: Back + duplicate export buttons — admin-only. Back
          goes to the (admin-only) Period step and the exports leak hours,
          so the whole row hides for non-admin viewers. */}
      {isAdmin && (
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
      )}

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
        } else if (kind === '0d') {
          rows = allRows.filter((r) => r.hours > 0 && r.daysOff === 0)
          title = 'Dispatchers with NO day off — rest violation'
          subtitle = `${wl} · 7 days worked · regenerate the schedule to fix`
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

      {/* Per-dispatcher detail modal — fired from peak-wk pill click. */}
      {dispatcherDetailId && (() => {
        const ds = schedule.dispatcherSchedules.find((x) => x.dispatcher.id === dispatcherDetailId)
        if (!ds) return null
        const { dispatcher, days, weeklyHours, totalHours } = ds
        const peak = Math.max(0, ...Object.values(weeklyHours))
        // Evening shifts = starts 15:00 or later. Under the two-team
        // model this is the interesting per-dispatcher stat (replaces
        // the old split-shift count).
        const eveningShifts = days.filter(
          (d) => !d.isOff && d.slots.findIndex(Boolean) >= 9,
        ).length
        const daysWorked = days.filter((d) => !d.isOff).length
        const daysOff = days.length - daysWorked
        // Group days by week for the per-week breakdown.
        const byWeek = new Map<string, typeof days>()
        for (const day of days) {
          const wl = schedule.dates.find((d) => d.date === day.date)?.weekLabel ?? ''
          if (!byWeek.has(wl)) byWeek.set(wl, [])
          byWeek.get(wl)!.push(day)
        }
        return (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/30 px-4"
            onClick={() => setDispatcherDetailId(null)}
          >
            <div
              className="flex max-h-[85vh] w-full max-w-lg flex-col rounded-2xl bg-white shadow-xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-3">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: dispatcher.color }} />
                  <div className="min-w-0">
                    <h3 className="truncate text-base font-semibold text-slate-800">{dispatcher.name}</h3>
                    <span className={clsx(
                      'mt-0.5 inline-block rounded px-1.5 py-0 text-[10px] font-bold',
                      dispatcher.level === 'Senior'  && 'bg-amber-100 text-amber-600',
                      dispatcher.level === 'Regular' && 'bg-blue-100 text-blue-600',
                      dispatcher.level === 'Trainee' && 'bg-slate-100 text-slate-500',
                    )}>
                      {dispatcher.level === 'Senior' ? 'SENIOR' : dispatcher.level === 'Regular' ? 'REGULAR' : 'TRAINEE'}
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setDispatcherDetailId(null)}
                  className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                  aria-label="Close"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto px-5 py-4">
                {/* Top summary */}
                <div className="grid grid-cols-4 gap-3 border-b border-slate-100 pb-4 text-center">
                  <div>
                    <div className={clsx('text-lg font-bold tabular-nums', hoursStatusColor(peak))}>{peak.toFixed(1)}h</div>
                    <div className="text-[10px] uppercase text-slate-400">peak wk</div>
                  </div>
                  <div>
                    <div className="text-lg font-bold tabular-nums text-slate-700">{totalHours.toFixed(1)}h</div>
                    <div className="text-[10px] uppercase text-slate-400">total</div>
                  </div>
                  <div>
                    <div className="text-lg font-bold tabular-nums text-slate-700">{daysWorked}/{daysOff}</div>
                    <div className="text-[10px] uppercase text-slate-400">on/off</div>
                  </div>
                  <div>
                    <div className="text-lg font-bold tabular-nums text-slate-700">{eveningShifts}</div>
                    <div className="text-[10px] uppercase text-slate-400">evenings</div>
                  </div>
                </div>
                {/* Per-week breakdown */}
                <ul className="mt-3 flex flex-col gap-3">
                  {[...byWeek.entries()].map(([wl, wdays]) => {
                    const wHours = wdays.reduce((s, d) => s + d.totalHours, 0)
                    const wOff = wdays.filter((d) => d.isOff)
                    return (
                      <li key={wl} className="rounded-lg border border-slate-100 p-3">
                        <div className="flex items-center justify-between gap-3 text-xs font-semibold text-slate-700">
                          <span>{wl}</span>
                          <span className={clsx('tabular-nums', hoursStatusColor(wHours))}>{wHours.toFixed(1)}h</span>
                        </div>
                        <div className="mt-2 grid grid-cols-7 gap-1 text-[11px]">
                          {wdays.map((d) => {
                            const dow = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][new Date(d.date + 'T12:00:00').getDay()]
                            return (
                              <div key={d.date} className={clsx(
                                'flex flex-col items-center rounded px-1 py-1 tabular-nums',
                                d.isOff ? 'bg-slate-100 text-slate-400' : 'bg-emerald-50 text-emerald-700',
                              )}>
                                <span className="text-[9px] uppercase opacity-70">{dow}</span>
                                <span className="font-bold">{d.isOff ? 'OFF' : `${d.totalHours}h`}</span>
                              </div>
                            )
                          })}
                        </div>
                        {wOff.length > 0 && (
                          <div className="mt-1.5 text-[10px] text-slate-500">
                            off: {wOff.map((d) => ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][new Date(d.date + 'T12:00:00').getDay()]).join(', ')}
                          </div>
                        )}
                      </li>
                    )
                  })}
                </ul>
              </div>
            </div>
          </div>
        )
      })()}

      {/* "See Rules Applied" — the standing hard rules the generator runs
          under, plus this schedule's week-by-week rotating 2nd-day-off
          decisions (grant / skip-and-defer with the reason). */}
      {rulesOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/30 px-4"
          onClick={() => setRulesOpen(false)}
        >
          <div
            className="flex max-h-[85vh] w-full max-w-lg flex-col rounded-2xl bg-white shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-3">
              <div className="min-w-0">
                <h3 className="flex items-center gap-2 text-base font-semibold text-slate-800">
                  <ScrollText className="h-4 w-4 text-slate-500" />
                  Rules applied to this schedule
                </h3>
                <p className="mt-0.5 text-xs text-slate-500">
                  {schedule.startDate} → {schedule.endDate}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setRulesOpen(false)}
                className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-5 py-4">
              <h4 className="text-[11px] font-bold uppercase tracking-wide text-slate-400">Hard rules</h4>
              <ul className="mt-2 flex list-disc flex-col gap-1.5 pl-4 text-[13px] leading-snug text-slate-600">
                <li>Everyone gets at least 1 full day off per work week (Thu–Wed) — never more than 6 days worked.</li>
                <li>Salaried staff have no hard 5-hour work cap — a block may run up to the 9-hour daily max. Any shift over 5 hours still includes one 30-minute paid break, placed after the heavy block in a demand trough (e.g. right after dinner ~8 PM or after lunch ~2 PM), never inside the lunch (11:30–2 PM) or dinner (5–8 PM) peaks, and staggered so the floor never empties.</li>
                <li>Coverage targets are hard minimums: no slot is ever left at 0, and any shortfall is at most 1 dispatcher deep, outside the peaks.</li>
                <li>Weekends run staggered edges: exactly 1 opener at 8 AM, one morning ending 3 PM and one ending 4 PM, both covering the whole lunch peak.</li>
                <li>Weekend days off rotate fairly — 1 dispatcher off Saturday, 1 off Sunday, never the same person both days.</li>
                <li>A recurring fully-blocked weekday counts as that dispatcher's weekly rest day.</li>
                <li>Days-off cap per week: Trainees 1, Regulars and Seniors up to 2.</li>
              </ul>

              <h4 className="mt-5 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-slate-400">
                <CalendarCheck2 className="h-3.5 w-3.5" />
                Rotating 2nd day off — this schedule
              </h4>
              <p className="mt-1.5 text-xs leading-snug text-slate-500">
                Regulars and Seniors take turns (roster order) at a 2nd day off. A turn is granted
                only when the week can afford it: at most +1 under-target unit, never inside a peak,
                never creating a 0-coverage slot, shortfall depth ≤ 1. A skipped turn is deferred —
                the same dispatcher stays first in line.
              </p>
              {(schedule.secondOffLog?.length ?? 0) === 0 ? (
                <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
                  No rotation record on this schedule (generated before this feature, or no full weeks in range).
                </p>
              ) : (
                <ul className="mt-3 flex flex-col divide-y divide-slate-100">
                  {schedule.secondOffLog!.map((rec) => (
                    <li key={rec.weekLabel} className="flex items-center justify-between gap-3 py-2 text-[13px]">
                      <div className="min-w-0">
                        <div className="font-semibold text-slate-700">{rec.weekLabel}</div>
                        <div className="mt-0.5 text-xs text-slate-500">
                          {rec.candidateName}
                          {rec.granted && rec.date && (
                            <> — off {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(rec.date + 'T12:00:00').getDay()]} {rec.date.slice(5)}</>
                          )}
                          {!rec.granted && <> — {rec.reason}</>}
                        </div>
                      </div>
                      <span
                        className={clsx(
                          'shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-semibold',
                          rec.granted
                            ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                            : 'border-amber-200 bg-amber-50 text-amber-700',
                        )}
                        title={rec.reason}
                      >
                        {rec.granted
                          ? `granted${typeof rec.unitDelta === 'number' && rec.unitDelta > 0 ? ` (+${rec.unitDelta})` : ''}`
                          : 'skipped · turn carried'}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
