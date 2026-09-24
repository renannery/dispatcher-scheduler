// ─────────────────────────────────────────────────────────────────────────
// Replicate a schedule pattern onto a new period — DISPATCHER-side editor
// feature. Core logic is team-agnostic (operates on the generic schedule
// shape); the dispatcher UI wires it up.
//
// TWO LOAD-BEARING DECISIONS (from the spec):
//   1. Map by DAY-OF-WEEK, never by date offset. Each target date receives the
//      shifts of the source date with the SAME day-of-week, cycling through the
//      source block's weeks in order (a 2-week source → repeating 2-week cycle).
//      A naive +N-day offset would rotate the DOW and land Friday patterns on
//      Saturday, misaligning every recurring block, override and Thu–Wed week.
//   2. STAMP + FLAG, never auto-repair. This module only stamps the pattern and
//      recomputes coverage; it never mutates shifts to satisfy the new context.
//      Validation is a separate, read-only pass (validateStamped) so every
//      violation the new period introduces is surfaced, not silently fixed.
//
// The generation path (generateSchedule and its passes) is deliberately NOT
// touched — this is an editor feature.
// ─────────────────────────────────────────────────────────────────────────
import { addDays, differenceInDays, format, parseISO } from 'date-fns'

import { effectiveCoverage, SLOTS } from '@/data/coverageTemplate'
import { SUPERVISION_BRIDGE_HOURS } from '@/utils/scheduler'
import type { Dispatcher, DispatcherTimeOff, GeneratedSchedule } from '@/types/schedule'

// Rest-rule thresholds — mirror scheduler.ts's private constants (kept local so
// the generation module stays untouched by this editor feature). A shift that
// ENDS at/after slot 17 (9 PM) followed next day by one that STARTS at/before
// slot 2 (10 AM) is an illegal night→morning turnaround.
const NIGHT_END_SLOT = 17
const MORNING_START_SLOT = 2

/** Thu → Wed work-week label. Mirrors scheduler.ts's private `weekLabel` — kept
 *  local on purpose so the generation module stays untouched by this feature. */
export function replicaWeekLabel(date: Date): string {
  const dow = date.getDay()
  const thu = addDays(date, -((dow + 3) % 7))
  const wed = addDays(thu, 6)
  return `${format(thu, 'MMM d')} – ${format(wed, 'MMM d')}`
}

export interface DateInfo {
  date: string
  dayLabel: string
  weekLabel: string
  dayOfWeek: number
}

export interface DowMapEntry {
  targetDate: string
  targetDow: number
  /** The source date whose shifts this target date copies (same DOW, cycled
   *  source week), or null when the cycled source week has no such DOW (a
   *  partial source week edge) — then every dispatcher is off that target day. */
  sourceDate: string | null
  /** Which source week (0-indexed, in order) this target date cycles to. */
  sourceWeekIndex: number
}

export interface ReplicationPlan {
  targetStart: string
  targetEnd: string
  targetDates: DateInfo[]
  /** Source week labels in chronological order — the repeating cycle unit. */
  sourceWeeks: string[]
  map: DowMapEntry[]
  /** True when the target's first day is a different DOW than the source's
   *  first day — the cycle still maps correctly by DOW, but the first target
   *  week is partial, which is worth surfacing so it isn't a surprise. */
  startDowMismatch: boolean
  /** Source weeks that don't cover all 7 DOWs — target dates cycling onto a
   *  missing DOW get no shift (dispatcher off), which the coverage check flags. */
  partialSourceWeeks: string[]
  notices: string[]
}

function buildDateInfos(startISO: string, endISO: string): DateInfo[] {
  const start = parseISO(startISO)
  const n = differenceInDays(parseISO(endISO), start) + 1
  return Array.from({ length: n }, (_, i) => {
    const d = addDays(start, i)
    return {
      date: format(d, 'yyyy-MM-dd'),
      dayLabel: format(d, 'EEE, MMMM do'),
      weekLabel: replicaWeekLabel(d),
      dayOfWeek: d.getDay(),
    }
  })
}

/** Ordered distinct values, first-seen order preserved. */
function orderedDistinct<T>(xs: T[]): T[] {
  const seen = new Set<T>()
  const out: T[] = []
  for (const x of xs) if (!seen.has(x)) { seen.add(x); out.push(x) }
  return out
}

/**
 * Build the DOW-cycle mapping from a source schedule to a target range.
 * Pure — computes only the date→date mapping and preview notices; no shifts
 * are stamped here (see applyReplication).
 */
export function planReplication(
  source: GeneratedSchedule,
  targetStart: string,
  targetEnd: string,
): ReplicationPlan {
  const sourceInfos: DateInfo[] = source.dates.map((d) => ({
    date: d.date, dayLabel: d.dayLabel, weekLabel: d.weekLabel, dayOfWeek: d.dayOfWeek,
  }))
  const targetDates = buildDateInfos(targetStart, targetEnd)

  // Source weeks in order, each as a DOW → source date lookup.
  const sourceWeeks = orderedDistinct(sourceInfos.map((d) => d.weekLabel))
  const weekDowDate = new Map<string, Map<number, string>>()
  for (const wl of sourceWeeks) weekDowDate.set(wl, new Map())
  for (const d of sourceInfos) weekDowDate.get(d.weekLabel)!.set(d.dayOfWeek, d.date)

  // Target weeks in order → cycle index into sourceWeeks.
  const targetWeeks = orderedDistinct(targetDates.map((d) => d.weekLabel))
  const targetWeekCycle = new Map<string, number>()
  targetWeeks.forEach((wl, i) => targetWeekCycle.set(wl, i % sourceWeeks.length))

  const map: DowMapEntry[] = targetDates.map((t) => {
    const cycle = targetWeekCycle.get(t.weekLabel)!
    const srcWeek = sourceWeeks[cycle]
    const sourceDate = weekDowDate.get(srcWeek)?.get(t.dayOfWeek) ?? null
    return { targetDate: t.date, targetDow: t.dayOfWeek, sourceDate, sourceWeekIndex: cycle }
  })

  const partialSourceWeeks = sourceWeeks.filter((wl) => (weekDowDate.get(wl)?.size ?? 0) < 7)
  const startDowMismatch =
    targetDates.length > 0 && sourceInfos.length > 0 &&
    targetDates[0].dayOfWeek !== sourceInfos[0].dayOfWeek

  const notices: string[] = []
  if (startDowMismatch) {
    notices.push(
      `Target starts on ${DOW_NAMES[targetDates[0].dayOfWeek]} but the source starts on ${DOW_NAMES[sourceInfos[0].dayOfWeek]} — shifts still map by day-of-week, but the first target week is partial.`,
    )
  }
  if (partialSourceWeeks.length > 0) {
    notices.push(
      `Source has ${partialSourceWeeks.length} partial week(s) (fewer than 7 days). Target days cycling onto a missing weekday get no shift and will flag as under-coverage.`,
    )
  }
  if (sourceWeeks.length > 1) {
    notices.push(`Source spans ${sourceWeeks.length} weeks — replicated as a repeating ${sourceWeeks.length}-week cycle.`)
  }

  return { targetStart, targetEnd, targetDates, sourceWeeks, map, startDowMismatch, partialSourceWeeks, notices }
}

const DOW_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/**
 * Stamp the source pattern onto the target range per the plan and return the
 * EXTENDED schedule: the source block unchanged + the replicated target block
 * appended, as one continuous schedule. Each dispatcher's shift on a target
 * date is copied verbatim from its mapped source date (or off when unmapped).
 * Target coverage is recomputed against the TARGET period's own overrides;
 * source coverage/warnings are preserved. No repair — validateStamped adds the
 * target-block warnings.
 *
 * On overlap (a target date already in the source), the target stamp wins.
 */
export function applyReplication(
  source: GeneratedSchedule,
  plan: ReplicationPlan,
  targetOverrides: Record<number, number[]>,
): GeneratedSchedule {
  const mapByTarget = new Map(plan.map.map((m) => [m.targetDate, m]))
  const targetDateSet = new Set(plan.targetDates.map((t) => t.date))
  const emptyBitmap = () => new Array<boolean>(SLOTS.length).fill(false)

  const dispatcherSchedules = source.dispatcherSchedules.map((ds) => {
    const srcDayByDate = new Map(ds.days.map((d) => [d.date, d]))
    const targetDays = plan.targetDates.map((t) => {
      const m = mapByTarget.get(t.date)!
      const srcDay = m.sourceDate ? srcDayByDate.get(m.sourceDate) : undefined
      const slots = srcDay && !srcDay.isOff ? [...srcDay.slots] : emptyBitmap()
      const totalHours = slots.reduce((s, on, i) => s + (on ? SLOTS[i].hours : 0), 0)
      return { date: t.date, dayLabel: t.dayLabel, dayOfWeek: t.dayOfWeek, slots, totalHours, isOff: totalHours === 0 }
    })
    // Merge: source days (minus any overlapped by target) + target days, sorted.
    const keptSource = ds.days.filter((d) => !targetDateSet.has(d.date))
    const days = [...keptSource, ...targetDays].sort((a, b) => a.date.localeCompare(b.date))
    const weeklyHours: Record<string, number> = {}
    for (const d of days) {
      const wl = replicaWeekLabel(new Date(d.date + 'T12:00:00'))
      weeklyHours[wl] = (weeklyHours[wl] ?? 0) + d.totalHours
    }
    const totalHours = Object.values(weeklyHours).reduce((s, h) => s + h, 0)
    return { dispatcher: ds.dispatcher, days, weeklyHours, totalHours }
  })

  // Merge dates (source minus overlap + target), sorted.
  const dates = [
    ...source.dates.filter((d) => !targetDateSet.has(d.date)),
    ...plan.targetDates,
  ].sort((a, b) => a.date.localeCompare(b.date))

  const coverageActual: Record<string, number[]> = { ...source.coverageActual }
  const coverageRequired: Record<string, number[]> = { ...(source.coverageRequired ?? {}) }
  for (const t of plan.targetDates) {
    const cov = new Array<number>(SLOTS.length).fill(0)
    for (const ds of dispatcherSchedules) {
      const e = ds.days.find((d) => d.date === t.date)
      if (!e || e.isOff) continue
      e.slots.forEach((on, i) => { if (on) cov[i]++ })
    }
    coverageActual[t.date] = cov
    coverageRequired[t.date] = effectiveCoverage(t.dayOfWeek, targetOverrides)
  }

  // Preserve the source block's own generated warnings; target-date warnings
  // are added by validateStamped (source dates are the approved block — not
  // re-flagged).
  const coverageWarnings: GeneratedSchedule['coverageWarnings'] = {}
  for (const [date, ws] of Object.entries(source.coverageWarnings ?? {})) {
    if (!targetDateSet.has(date)) coverageWarnings[date] = ws
  }
  const supervisionSlots = source.supervisionSlots
  const supervisionConcessions = source.supervisionConcessions

  return {
    startDate: dates[0]?.date ?? plan.targetStart,
    endDate: dates[dates.length - 1]?.date ?? plan.targetEnd,
    seed: source.seed,
    dates,
    dispatcherSchedules,
    coverageActual,
    coverageRequired,
    coverageWarnings,
    ...(supervisionSlots ? { supervisionSlots } : {}),
    ...(supervisionConcessions ? { supervisionConcessions } : {}),
    secondOffLog: source.secondOffLog,
  }
}

/**
 * Slice a schedule to a date range [startISO, endISO] inclusive, producing a
 * self-contained schedule for that window. Used to scope EXPORTS to the
 * replicated block while the underlying continuous schedule stays intact
 * (the seam validation already ran against the full data — its warnings are
 * baked into the day records and travel with the slice). Presentation only:
 * shifts, coverage and warnings are copied verbatim, never recomputed.
 */
export function sliceSchedule(schedule: GeneratedSchedule, startISO: string, endISO: string): GeneratedSchedule {
  const inRange = (d: string) => d >= startISO && d <= endISO
  const dates = schedule.dates.filter((d) => inRange(d.date))
  const dispatcherSchedules = schedule.dispatcherSchedules.map((ds) => {
    const days = ds.days.filter((d) => inRange(d.date))
    const weeklyHours: Record<string, number> = {}
    for (const d of days) {
      const wl = replicaWeekLabel(new Date(d.date + 'T12:00:00'))
      weeklyHours[wl] = (weeklyHours[wl] ?? 0) + d.totalHours
    }
    const totalHours = Object.values(weeklyHours).reduce((s, h) => s + h, 0)
    return { dispatcher: ds.dispatcher, days, weeklyHours, totalHours }
  })
  const pick = <T>(rec: Record<string, T> | undefined): Record<string, T> => {
    const out: Record<string, T> = {}
    for (const [k, v] of Object.entries(rec ?? {})) if (inRange(k)) out[k] = v
    return out
  }
  return {
    startDate: startISO,
    endDate: endISO,
    seed: schedule.seed,
    dates,
    dispatcherSchedules,
    coverageActual: pick(schedule.coverageActual),
    coverageRequired: pick(schedule.coverageRequired),
    coverageWarnings: pick(schedule.coverageWarnings),
    ...(schedule.supervisionSlots ? { supervisionSlots: pick(schedule.supervisionSlots) } : {}),
    ...(schedule.supervisionConcessions ? { supervisionConcessions: pick(schedule.supervisionConcessions) } : {}),
    secondOffLog: schedule.secondOffLog,
  }
}

const first = (sl: boolean[]) => sl.findIndex(Boolean)
const last = (sl: boolean[]) => { for (let i = sl.length - 1; i >= 0; i--) if (sl[i]) return i; return -1 }

/**
 * READ-ONLY validation of the stamped target block against the new period's
 * context — never mutates shifts. Produces day-level warning chips for the
 * things the live grid can't show on its own:
 *   • rest-violation — an illegal night→morning turnaround, INCLUDING the seam
 *     between the source block's last day and the target's first day;
 *   • supervision — a Trainee left alone or Regular-bridged beyond the limit;
 *   • block-conflict — a stamped shift landing on a slot the target period now
 *     blocks (new time-off request or edited recurring block): the shift is
 *     kept (not silently honored) AND surfaced (not silently overridden).
 *
 * Coverage-vs-target-overrides, off-cap (days off / hours) and per-cell
 * block conflicts already render live from the stamped schedule, so they are
 * not duplicated here.
 *
 * `datesToCheck` scopes validation to the replicated block; the source block
 * keeps its own approved warnings.
 */
export function validateStamped(
  schedule: GeneratedSchedule,
  dispatchers: Dispatcher[],
  timeOff: DispatcherTimeOff,
  datesToCheck: string[],
): NonNullable<GeneratedSchedule['coverageWarnings']> {
  const out: NonNullable<GeneratedSchedule['coverageWarnings']> = {}
  const dispById = new Map(dispatchers.map((d) => [d.id, d]))
  const orderedDates = schedule.dates.map((d) => d.date)
  const push = (date: string, w: { peak: 'rest-violation' | 'supervision' | 'block-conflict'; reason: string; slotIndex?: number }) => {
    (out[date] ??= []).push(w)
  }
  const check = new Set(datesToCheck)

  for (const di of schedule.dates) {
    if (!check.has(di.date)) continue
    const dow = di.dayOfWeek
    const prevDate = orderedDates[orderedDates.indexOf(di.date) - 1]

    for (const ds of schedule.dispatcherSchedules) {
      const day = ds.days.find((d) => d.date === di.date)
      if (!day || day.isOff) continue
      const disp = dispById.get(ds.dispatcher.id)

      // ── rest-violation (incl. seam) ──────────────────────────────────
      const st = first(day.slots)
      if (st >= 0 && st <= MORNING_START_SLOT && prevDate) {
        const prev = ds.days.find((d) => d.date === prevDate)
        if (prev && !prev.isOff && last(prev.slots) >= NIGHT_END_SLOT) {
          const seam = !check.has(prevDate)
          push(di.date, {
            peak: 'rest-violation',
            reason: `${ds.dispatcher.name} closes late the day before and starts in the morning — under the required overnight rest${seam ? ' (seam between the existing block and the replicated block)' : ''}.`,
          })
        }
      }

      // ── block-conflict (stamped shift on a now-blocked slot) ─────────
      const conflicts: number[] = []
      day.slots.forEach((on, s) => {
        if (!on) return
        const to = timeOff[ds.dispatcher.id]?.[di.date]?.[s] ?? false
        const rec = disp?.recurringBlocks?.[dow]?.[s] ?? false
        if (to || rec) conflicts.push(s)
      })
      if (conflicts.length) {
        push(di.date, {
          peak: 'block-conflict',
          reason: `${ds.dispatcher.name} is stamped working ${conflicts.map((s) => SLOTS[s].label).join(', ')} but the new period blocks it (time-off or recurring block) — kept as stamped; adjust manually.`,
          slotIndex: conflicts[0],
        })
      }
    }

    // ── supervision (Trainee alone / Regular-bridged beyond the limit) ──
    for (const tds of schedule.dispatcherSchedules) {
      if (tds.dispatcher.level !== 'Trainee') continue
      const tday = tds.days.find((d) => d.date === di.date)
      if (!tday || tday.isOff) continue
      const peers = schedule.dispatcherSchedules.filter((d) => d !== tds)
      const at = (lvl: string, s: number) => peers.some((p) => {
        const d = p.days.find((x) => x.date === di.date)
        return p.dispatcher.level === lvl && d && !d.isOff && d.slots[s]
      })
      const alone: number[] = []
      let run = 0, daily = 0, contig = 0
      for (let s = 0; s < SLOTS.length; s++) {
        if (!tday.slots[s]) { run = 0; continue }
        if (at('Senior', s)) { run = 0; continue }
        if (!at('Regular', s)) { alone.push(s); run = 0; continue }
        run += SLOTS[s].hours; daily += SLOTS[s].hours; contig = Math.max(contig, run)
      }
      const bridgeFail = daily > SUPERVISION_BRIDGE_HOURS + 1e-9 || contig > SUPERVISION_BRIDGE_HOURS + 1e-9
      if (alone.length || bridgeFail) {
        const parts: string[] = []
        if (alone.length) parts.push(`${tds.dispatcher.name} works ${alone.map((s) => SLOTS[s].label).join(', ')} with no Senior and no Regular on shift`)
        if (bridgeFail) parts.push(`${daily}h of her day is Regular-bridged (max ${SUPERVISION_BRIDGE_HOURS}h)`)
        push(di.date, { peak: 'supervision', reason: `Supervision: ${parts.join('; ')} — introduced by the replicated pattern in this period; adjust manually.`, slotIndex: alone[0] })
      }
    }
  }
  return out
}

/**
 * Convenience wrapper: plan → stamp (extended) → validate the replicated block →
 * merge warnings. Returns the extended schedule and the plan (for the preview).
 */
export function replicateToNewPeriod(
  source: GeneratedSchedule,
  dispatchers: Dispatcher[],
  timeOff: DispatcherTimeOff,
  targetOverrides: Record<number, number[]>,
  targetStart: string,
  targetEnd: string,
): { schedule: GeneratedSchedule; plan: ReplicationPlan } {
  const plan = planReplication(source, targetStart, targetEnd)
  const extended = applyReplication(source, plan, targetOverrides)
  const targetWarnings = validateStamped(extended, dispatchers, timeOff, plan.targetDates.map((t) => t.date))
  const coverageWarnings = { ...(extended.coverageWarnings ?? {}) }
  for (const [date, ws] of Object.entries(targetWarnings)) {
    coverageWarnings[date] = [...(coverageWarnings[date] ?? []), ...ws]
  }
  return { schedule: { ...extended, coverageWarnings }, plan }
}
