import { addDays, differenceInDays, format, parseISO } from 'date-fns'

import { DAY_TEMPLATES, SLOTS } from '@/data/coverageTemplate'
import type {
  Dispatcher,
  DispatcherDayEntry,
  DispatcherSchedule,
  GeneratedSchedule,
} from '@/types/schedule'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fri, Sat, Sun — the "heavy" weekend days that we rotate off every 2 weeks. */
export const HEAVY_DAYS = new Set([5, 6, 0]) // Fri, Sat, Sun

/**
 * Returns the id of the dispatcher who gets Fri/Sat/Sun off on the 2-week
 * block that contains `date`.  Block 0 → dispatchers[0], block 1 →
 * dispatchers[1], …, wrapping around.
 *
 * "Block" boundaries are aligned to the Thursday-start work week so that the
 * rotation always changes on a Thursday, never mid-week.
 */
export function weekendOffDispatcherId(
  date: Date,
  scheduleStart: Date,
  dispatchers: Dispatcher[],
): string | null {
  if (dispatchers.length < 2) return null
  // Find the Thursday that owns each date's work week
  const toThursday = (d: Date) => {
    const dow = d.getDay()
    return addDays(d, -((dow + 3) % 7))
  }
  const startThu = toThursday(scheduleStart)
  const dateThu  = toThursday(date)
  const weeksSinceStart = Math.round(differenceInDays(dateThu, startThu) / 7)
  const twoWeekBlock = Math.floor(weeksSinceStart / 2)
  const idx = twoWeekBlock % dispatchers.length
  return dispatchers[idx].id
}

function slotHours(slots: boolean[]): number {
  return slots.reduce((sum, on, i) => sum + (on ? SLOTS[i].hours : 0), 0)
}

function weekLabel(date: Date): string {
  // Work week runs Thu → Wed
  // (dow + 3) % 7 gives the number of days since the last Thursday
  const dow = date.getDay()
  const thu = addDays(date, -((dow + 3) % 7))
  const wed = addDays(thu, 6)
  return `${format(thu, 'MMM d')} – ${format(wed, 'MMM d')}`
}

/** Index of first working slot in a pattern (-1 if none). */
function firstActiveSlot(pattern: boolean[]): number {
  return pattern.findIndex((v) => v)
}

/** Index of last working slot in a pattern (-1 if none). */
function lastActiveSlot(pattern: boolean[]): number {
  for (let i = pattern.length - 1; i >= 0; i--) {
    if (pattern[i]) return i
  }
  return -1
}

/**
 * A "night shift" ends at slot 17 (9–10 PM) or later.
 * Dispatchers who worked a night shift should not be assigned a morning
 * pattern (starts at slot 0/1/2 — 8/9/10 AM) the following day.
 */
const NIGHT_SLOT_THRESHOLD = 17  // 9 PM
const MORNING_SLOT_THRESHOLD = 2 // starts ≤ 10 AM

// ---------------------------------------------------------------------------
// Main generator
// ---------------------------------------------------------------------------

export function generateSchedule(
  dispatchers: Dispatcher[],
  startDate: string,
  endDate: string,
  timeOffDates: Record<string, string[]>,
): GeneratedSchedule {
  const start = parseISO(startDate)
  const end = parseISO(endDate)
  const totalDays = differenceInDays(end, start) + 1

  const allDates = Array.from({ length: totalDays }, (_, i) => addDays(start, i))

  // Per-dispatcher, per-week hour accumulator
  const weekHours: Record<string, Record<string, number>> = {}
  dispatchers.forEach((d) => (weekHours[d.id] = {}))

  // Track the last active slot index each dispatcher worked on each date
  // (used to enforce the night-rest constraint)
  const lastSlotWorked: Record<string, Record<string, number>> = {}
  dispatchers.forEach((d) => (lastSlotWorked[d.id] = {}))

  const scheduleMap: Record<string, DispatcherDayEntry[]> = {}
  dispatchers.forEach((d) => (scheduleMap[d.id] = []))
  const coverageActual: Record<string, number[]> = {}

  let dayIndex = 0

  for (const date of allDates) {
    const dateStr = format(date, 'yyyy-MM-dd')
    const dow = date.getDay()
    const template = DAY_TEMPLATES[dow]
    const wLabel = weekLabel(date)
    const dayLabel = format(date, 'EEE, MMM d')
    const yesterday = format(addDays(date, -1), 'yyyy-MM-dd')

    // Pre-compute pattern metadata (once per day)
    const patternMeta = template.shiftPatterns.map((raw, idx) => {
      const bool = raw.map((v) => v === 1)
      return {
        idx,
        bool,
        hours: slotHours(bool),
        first: firstActiveSlot(bool),
        last: lastActiveSlot(bool),
        isMorning: firstActiveSlot(bool) <= MORNING_SLOT_THRESHOLD,
      }
    })

    // Sort patterns: morning first (longest first within group), then late
    const sortedPatterns = [
      ...patternMeta.filter((p) => p.isMorning).sort((a, b) => b.hours - a.hours),
      ...patternMeta.filter((p) => !p.isMorning).sort((a, b) => b.hours - a.hours),
    ]

    // Rotate dispatcher order for variety (step 3 per day visits all positions)
    const rotationOffset = (dayIndex * 3) % dispatchers.length
    dayIndex++
    const rotated = [
      ...dispatchers.slice(rotationOffset),
      ...dispatchers.slice(0, rotationOffset),
    ]

    // Which dispatcher (if any) gets Fri/Sat/Sun off this 2-week block?
    const weekendOffId = HEAVY_DAYS.has(dow)
      ? weekendOffDispatcherId(date, start, dispatchers)
      : null

    // Split into off-today, 40h-capped, and available pools
    const offToday: typeof dispatchers = []
    const cappedDispatchers: typeof dispatchers = []
    const workingPool: typeof dispatchers = []

    for (const d of rotated) {
      const hasTimeOff    = new Set(timeOffDates[d.id] ?? []).has(dateStr)
      const onWeekendBreak = d.id === weekendOffId
      if (hasTimeOff || onWeekendBreak) {
        offToday.push(d)
      } else if ((weekHours[d.id][wLabel] ?? 0) >= 40) {
        cappedDispatchers.push(d)
      } else {
        workingPool.push(d)
      }
    }

    // Sort available dispatchers by ascending weekly hours → balances totals
    const sortedWorking = [...workingPool].sort(
      (a, b) => (weekHours[a.id][wLabel] ?? 0) - (weekHours[b.id][wLabel] ?? 0),
    )

    // Night-rest check: did this dispatcher work a night shift yesterday?
    const workedNightYesterday = (dispId: string) =>
      (lastSlotWorked[dispId][yesterday] ?? -1) >= NIGHT_SLOT_THRESHOLD

    // Greedy assignment: each pattern picks the best eligible dispatcher.
    // Constraint: if any Senior is available, ensure at least one is assigned.
    const hasSeniors = sortedWorking.some((d) => d.level === 'Senior')
    const usedIds = new Set<string>()
    const assignments: Array<{ dispatcher: (typeof dispatchers)[0]; pattern: boolean[] }> = []
    let seniorAssigned = false

    for (const p of sortedPatterns) {
      // Morning patterns exclude dispatchers who worked night yesterday
      const eligible = sortedWorking.filter(
        (d) => !usedIds.has(d.id) && (!p.isMorning || !workedNightYesterday(d.id)),
      )
      if (eligible.length === 0) break

      // If no Senior has been assigned yet and Seniors are available, promote
      // the least-hours Senior to the front of the candidate list.
      let dispatcher: (typeof dispatchers)[0]
      if (hasSeniors && !seniorAssigned) {
        const seniors = eligible.filter((d) => d.level === 'Senior')
        dispatcher = seniors.length > 0 ? seniors[0] : eligible[0]
      } else {
        dispatcher = eligible[0]
      }

      if (dispatcher.level === 'Senior') seniorAssigned = true
      assignments.push({ dispatcher, pattern: p.bool })
      usedIds.add(dispatcher.id)
    }

    // Dispatchers not assigned are off today
    const dayOff = [
      ...sortedWorking.filter((d) => !usedIds.has(d.id)),
      ...cappedDispatchers,
      ...offToday,
    ]

    // Accumulate coverage and build schedule entries
    const actualCov = new Array(SLOTS.length).fill(0)

    for (const { dispatcher, pattern } of assignments) {
      const hours = slotHours(pattern)
      weekHours[dispatcher.id][wLabel] = (weekHours[dispatcher.id][wLabel] ?? 0) + hours
      lastSlotWorked[dispatcher.id][dateStr] = lastActiveSlot(pattern)

      scheduleMap[dispatcher.id].push({
        date: dateStr, dayLabel, dayOfWeek: dow,
        slots: [...pattern], totalHours: hours, isOff: false,
      })

      pattern.forEach((on, si) => { if (on) actualCov[si]++ })
    }

    for (const dispatcher of dayOff) {
      scheduleMap[dispatcher.id].push({
        date: dateStr, dayLabel, dayOfWeek: dow,
        slots: new Array(SLOTS.length).fill(false),
        totalHours: 0, isOff: true,
      })
    }

    coverageActual[dateStr] = actualCov
  }

  // Build final DispatcherSchedule objects
  const dispatcherSchedules: DispatcherSchedule[] = dispatchers.map((d) => {
    const days = scheduleMap[d.id]
    const wh = weekHours[d.id]
    const totalHours = Object.values(wh).reduce((s, h) => s + h, 0)
    return { dispatcher: d, days, weeklyHours: wh, totalHours }
  })

  const dates = allDates.map((d) => ({
    date: format(d, 'yyyy-MM-dd'),
    dayLabel: format(d, 'EEE, MMM d'),
    weekLabel: weekLabel(d),
    dayOfWeek: d.getDay(),
  }))

  return { startDate, endDate, dates, dispatcherSchedules, coverageActual }
}

// ---------------------------------------------------------------------------
// Coverage & colour helpers
// ---------------------------------------------------------------------------

export function coverageStatus(actual: number, required: number): 'ok' | 'over' | 'short' {
  if (actual >= required) return required === 0 ? 'over' : 'ok'
  return 'short'
}

export function hoursStatusColor(hours: number): string {
  if (hours > 45) return 'text-red-600'
  if (hours >= 36) return 'text-emerald-600'
  return 'text-amber-600'
}

export function hoursStatusBg(hours: number): string {
  if (hours > 45) return 'bg-red-100 text-red-700 border-red-200'
  if (hours >= 36) return 'bg-emerald-100 text-emerald-700 border-emerald-200'
  return 'bg-amber-100 text-amber-700 border-amber-200'
}
