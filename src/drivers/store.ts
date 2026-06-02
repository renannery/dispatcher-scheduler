import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

import type { AbsenceReason } from '@/utils/absence'
import { datesInRange } from '@/utils/absence'
import type { DriverSnapshotData } from '@/utils/snapshot'

import { DEFAULT_FULL_TIME_CAP, DEFAULT_PART_TIME_CAP, DRIVER_DAY_TEMPLATES, DRIVER_SLOTS } from './coverageTemplate'
import type { Driver, DriverStep, DriverTimeOff, EmploymentType, GeneratedDriverSchedule } from './types'

const DRIVER_COLORS = [
  '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
  '#06b6d4', '#ec4899', '#84cc16', '#f97316', '#6366f1',
  '#14b8a6', '#e11d48', '#7c3aed', '#0ea5e9', '#d97706',
  '#22c55e', '#a855f7', '#f43f5e', '#0d9488', '#65a30d',
]

function makeId() {
  return Math.random().toString(36).slice(2, 9)
}

function nextThursday(): string {
  const d = new Date()
  const day = d.getDay()
  const daysUntil = day === 4 ? 7 : (4 - day + 7) % 7
  d.setDate(d.getDate() + daysUntil)
  return d.toISOString().slice(0, 10)
}

/**
 * Computes the next work-week cycle (Thursday → following Wednesday).
 * Exported so UI affordances ("Next cycle" button on the date picker)
 * can produce the same range the store uses for its initial default.
 */
export function nextWorkWeekRange(): { start: string; end: string } {
  const start = nextThursday()
  return { start, end: addDays(start, 6) }
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T00:00:00')
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}

const defaultStart = nextThursday()

export type AbsenceReasonMap = Record<string, Record<string, AbsenceReason>>

interface DriverSchedulerStore {
  step: DriverStep
  drivers: Driver[]
  startDate: string
  endDate: string
  fullTimeCap: number
  partTimeCap: number
  /**
   * Multiplier on the per-slot required-coverage targets. 1.0 = use the
   * reference 56-driver baseline as-is; >1.0 to scale up when the roster
   * has grown; <1.0 to scale down for smaller teams.
   */
  coverageScale: number
  /**
   * Per day-of-week (0=Sun…6=Sat) override of the required-coverage array
   * (15 slots each). When present, the entry replaces the day-template
   * baseline before `coverageScale` is applied. Absent days fall through
   * to the template defaults. Lets ops fine-tune individual slots without
   * a code change.
   */
  coverageOverrides: Record<number, number[]>
  /** Minimum hours per shift. Defaults to 4. Patterns shorter than this are filtered out. */
  minHoursPerDay: number
  /** Maximum hours per shift. Defaults to 9. Patterns longer than this are filtered out. */
  maxHoursPerDay: number
  timeOff: DriverTimeOff
  /** Per driver, per date, the user-assigned reason for the absence. Display-only. */
  absenceReasons: AbsenceReasonMap
  /**
   * Persists the weekend-off rotation cursor across sessions so each fresh
   * Generate picks up where the previous schedule left off — instead of
   * always starting at the alphabetically-first driver.
   */
  weekendRotationOffset: number
  schedule: GeneratedDriverSchedule | null
  /**
   * Undo / redo stacks for interactive schedule edits (slot toggles).
   * Each entry is a full schedule snapshot saved at the moment BEFORE
   * a toggle was applied. Bounded at 50 entries to keep memory in check
   * on long editing sessions. Cleared whenever a fresh schedule is
   * generated, hydrated, or otherwise wholesale-replaced.
   */
  scheduleUndoStack: GeneratedDriverSchedule[]
  scheduleRedoStack: GeneratedDriverSchedule[]

  setStep: (step: DriverStep) => void
  addDriver: (name: string, employmentType?: EmploymentType, options?: { driverId?: string; isShopper?: boolean }) => void
  removeDriver: (id: string) => void
  setEmploymentType: (id: string, type: EmploymentType) => void
  setShopperStatus: (id: string, isShopper: boolean) => void
  toggleRecurringBlock: (id: string, dayOfWeek: number, slotIndex: number) => void
  setRecurringBlocks: (id: string, blocks: boolean[][]) => void
  setDateRange: (start: string, end: string) => void
  setFullTimeCap: (cap: number) => void
  setPartTimeCap: (cap: number) => void
  setCoverageScale: (scale: number) => void
  setCoverageOverride: (dayOfWeek: number, slotIndex: number, value: number) => void
  resetCoverageOverrides: () => void
  setMinHoursPerDay: (hours: number) => void
  setMaxHoursPerDay: (hours: number) => void
  /** Bump the persisted rotation cursor by N weeks (called after Generate). */
  advanceWeekendRotation: (weeks: number) => void
  /** Toggle full-day off for this driver on this date. */
  toggleFullDayOff: (driverId: string, date: string) => void
  /** Toggle a single slot on this driver's date-specific block bitmap. */
  toggleBlockedSlot: (driverId: string, date: string, slotIndex: number) => void
  /**
   * Mark every date in [start, end] (inclusive) with a reason.
   * If `slotMask` is provided, only those slots are blocked on each date
   * (e.g. "Mon-Fri 3-4 PM appointment"); otherwise the whole day is off.
   */
  applyAbsenceRange: (
    driverId: string,
    start: string,
    end: string,
    reason: AbsenceReason,
    slotMask?: boolean[],
  ) => void
  setSchedule: (s: GeneratedDriverSchedule) => void
  toggleDriverSlot: (driverId: string, date: string, slotIndex: number) => void
  /**
   * Apply a new schedule produced by the shuffler (rotates patterns
   * across drivers, coverage unchanged). PUSHES the pre-shuffle schedule
   * onto the undo stack so Cmd+Z reverses the shuffle — unlike setSchedule
   * which clears history because it implies a fresh generate.
   */
  applyShuffledSchedule: (s: GeneratedDriverSchedule) => void
  /** Undo the most recent toggleDriverSlot edit. No-op if undo stack is empty. */
  undoScheduleEdit: () => void
  /** Redo the most recently-undone edit. No-op if redo stack is empty. */
  redoScheduleEdit: () => void
  /** True when there's at least one entry on the undo stack. */
  canUndoScheduleEdit: () => boolean
  /** True when there's at least one entry on the redo stack. */
  canRedoScheduleEdit: () => boolean
  /** Replace entire store contents from a parsed snapshot. Jumps to the schedule step. */
  hydrateFromSnapshot: (data: DriverSnapshotData) => void
  /**
   * Partial hydrate for the period step: pulls the roster + rotation cursor
   * (and caps) from a previous schedule snapshot so the new period continues
   * the weekend-off rotation. Advances the date range to the week after the
   * snapshot's end. Leaves time-off / absence reasons / schedule alone.
   */
  importRotationContext: (data: DriverSnapshotData) => void
  reset: () => void
}

function makeFullBitmap(): boolean[] {
  return new Array(DRIVER_SLOTS.length).fill(true)
}
function isAllFalse(arr: boolean[] | undefined): boolean {
  return !arr || arr.every((v) => !v)
}
function isAllTrue(arr: boolean[] | undefined): boolean {
  return !!arr && arr.length === DRIVER_SLOTS.length && arr.every(Boolean)
}

// Maximum number of schedule snapshots kept on the undo stack. Long
// editing sessions can otherwise balloon localStorage past quota since
// every snapshot is a full schedule (~hundreds of KB on big rosters).
const SCHEDULE_HISTORY_MAX = 50

export const useDriverStore = create<DriverSchedulerStore>()(persist((set, get) => ({
  step: 'names',
  drivers: [],
  startDate: defaultStart,
  endDate: addDays(defaultStart, 6),
  fullTimeCap: DEFAULT_FULL_TIME_CAP,
  partTimeCap: DEFAULT_PART_TIME_CAP,
  coverageScale: 1,
  coverageOverrides: {},
  minHoursPerDay: 4,
  maxHoursPerDay: 9,
  timeOff: {},
  absenceReasons: {},
  weekendRotationOffset: 0,
  schedule: null,
  scheduleUndoStack: [],
  scheduleRedoStack: [],

  setStep: (step) => set({ step }),

  addDriver: (name, employmentType = 'full', options) =>
    set((s) => {
      const trimmed = name.trim()
      if (!trimmed) return s
      // Dedup by driverId when provided (so re-importing the same CSV doesn't
      // duplicate), otherwise by name.
      if (options?.driverId) {
        if (s.drivers.some((d) => d.driverId === options.driverId)) return s
      } else if (s.drivers.some((d) => d.name.toLowerCase() === trimmed.toLowerCase())) {
        return s
      }
      const color = DRIVER_COLORS[s.drivers.length % DRIVER_COLORS.length]
      const newDriver: Driver = {
        id: makeId(),
        name: trimmed,
        color,
        employmentType,
        ...(options?.driverId ? { driverId: options.driverId } : {}),
        ...(options?.isShopper ? { isShopper: true } : {}),
      }
      const next = [...s.drivers, newDriver]
      next.sort((a, b) => a.name.localeCompare(b.name))
      return { drivers: next }
    }),

  setEmploymentType: (id, employmentType) =>
    set((s) => ({
      drivers: s.drivers.map((d) => (d.id === id ? { ...d, employmentType } : d)),
    })),

  setShopperStatus: (id, isShopper) =>
    set((s) => ({
      drivers: s.drivers.map((d) => {
        if (d.id !== id) return d
        if (isShopper) return { ...d, isShopper: true }
        // Strip the field when toggling off so serialized snapshots stay clean.
        const next = { ...d }
        delete next.isShopper
        return next
      }),
    })),

  toggleRecurringBlock: (id, dayOfWeek, slotIndex) =>
    set((s) => ({
      drivers: s.drivers.map((d) => {
        if (d.id !== id) return d
        const grid = d.recurringBlocks
          ? d.recurringBlocks.map((row) => [...row])
          : Array.from({ length: 7 }, () => new Array(DRIVER_SLOTS.length).fill(false))
        grid[dayOfWeek][slotIndex] = !grid[dayOfWeek][slotIndex]
        // If completely empty, drop the field
        const empty = grid.every((row) => row.every((v) => !v))
        return { ...d, recurringBlocks: empty ? undefined : grid }
      }),
    })),

  setRecurringBlocks: (id, blocks) =>
    set((s) => ({
      drivers: s.drivers.map((d) => {
        if (d.id !== id) return d
        const empty = blocks.every((row) => row.every((v) => !v))
        return { ...d, recurringBlocks: empty ? undefined : blocks.map((row) => [...row]) }
      }),
    })),

  removeDriver: (id) =>
    set((s) => ({
      drivers: s.drivers.filter((d) => d.id !== id),
      timeOff: Object.fromEntries(Object.entries(s.timeOff).filter(([k]) => k !== id)),
      absenceReasons: Object.fromEntries(Object.entries(s.absenceReasons).filter(([k]) => k !== id)),
    })),

  setDateRange: (startDate, endDate) => set({ startDate, endDate }),
  setFullTimeCap: (fullTimeCap) => set({ fullTimeCap }),
  setPartTimeCap: (partTimeCap) => set({ partTimeCap }),
  setCoverageScale: (coverageScale) => set({ coverageScale: Math.max(0.5, Math.min(2, coverageScale)) }),

  setCoverageOverride: (dayOfWeek, slotIndex, value) =>
    set((s) => {
      const current = s.coverageOverrides[dayOfWeek] ?? [...DRIVER_DAY_TEMPLATES[dayOfWeek].requiredCoverage]
      const next = [...current]
      next[slotIndex] = Math.max(0, Math.round(value))
      return { coverageOverrides: { ...s.coverageOverrides, [dayOfWeek]: next } }
    }),

  resetCoverageOverrides: () => set({ coverageOverrides: {} }),

  setMinHoursPerDay: (hours) => set({ minHoursPerDay: Math.max(1, Math.min(12, Math.round(hours))) }),
  setMaxHoursPerDay: (hours) => set({ maxHoursPerDay: Math.max(1, Math.min(12, Math.round(hours))) }),

  advanceWeekendRotation: (weeks) =>
    set((s) => ({ weekendRotationOffset: s.weekendRotationOffset + Math.max(0, Math.floor(weeks)) })),

  toggleFullDayOff: (driverId, date) =>
    set((s) => {
      const driverMap = { ...(s.timeOff[driverId] ?? {}) }
      const reasonMap = { ...(s.absenceReasons[driverId] ?? {}) }
      const existing = driverMap[date]
      if (isAllTrue(existing)) {
        delete driverMap[date]
        delete reasonMap[date]
      } else {
        driverMap[date] = makeFullBitmap()
        // toggleFullDayOff alone doesn't set a reason — that's only via applyAbsenceRange
      }
      return {
        timeOff: { ...s.timeOff, [driverId]: driverMap },
        absenceReasons: { ...s.absenceReasons, [driverId]: reasonMap },
      }
    }),

  toggleBlockedSlot: (driverId, date, slotIndex) =>
    set((s) => {
      const driverMap = { ...(s.timeOff[driverId] ?? {}) }
      const reasonMap = { ...(s.absenceReasons[driverId] ?? {}) }
      const existing = driverMap[date] ?? new Array(DRIVER_SLOTS.length).fill(false)
      const next = [...existing]
      next[slotIndex] = !next[slotIndex]
      if (isAllFalse(next)) {
        delete driverMap[date]
        delete reasonMap[date]
      } else {
        driverMap[date] = next
        // Reason persists for partial blocks too (Phase 2: hour-range absences).
      }
      return {
        timeOff: { ...s.timeOff, [driverId]: driverMap },
        absenceReasons: { ...s.absenceReasons, [driverId]: reasonMap },
      }
    }),

  applyAbsenceRange: (driverId, start, end, reason, slotMask) =>
    set((s) => {
      const driverMap = { ...(s.timeOff[driverId] ?? {}) }
      const reasonMap = { ...(s.absenceReasons[driverId] ?? {}) }
      for (const date of datesInRange(start, end)) {
        if (slotMask) {
          // Union with any existing blocks for that date (don't blow them away)
          const existing = driverMap[date] ?? new Array(DRIVER_SLOTS.length).fill(false)
          const merged = existing.map((on, i) => on || !!slotMask[i])
          driverMap[date] = merged
        } else {
          driverMap[date] = makeFullBitmap()
        }
        reasonMap[date] = reason
      }
      return {
        timeOff: { ...s.timeOff, [driverId]: driverMap },
        absenceReasons: { ...s.absenceReasons, [driverId]: reasonMap },
      }
    }),

  setSchedule: (schedule) =>
    // Generating a fresh schedule wholesale-replaces the grid, so any
    // interactive edits from the previous run are no longer meaningful
    // — drop the undo/redo stacks instead of letting them point at a
    // schedule that no longer exists.
    set({ schedule, scheduleUndoStack: [], scheduleRedoStack: [] }),

  applyShuffledSchedule: (shuffled) =>
    set((state) => {
      if (!state.schedule) return { schedule: shuffled }
      // Shuffle is a targeted edit (just rotates drivers across patterns),
      // not a full regenerate — preserve undo history and push the pre-
      // shuffle schedule onto the undo stack so Cmd+Z reverses it.
      const nextUndo = [...state.scheduleUndoStack, state.schedule].slice(-50)
      return {
        schedule: shuffled,
        scheduleUndoStack: nextUndo,
        scheduleRedoStack: [],
      }
    }),

  toggleDriverSlot: (driverId, date, slotIndex) =>
    set((state) => {
      if (!state.schedule) return state
      const sch = state.schedule
      const slotCount = sch.driverSchedules[0]?.days[0]?.slots.length ?? 15
      // Snapshot the PRE-edit schedule onto the undo stack so Cmd/Ctrl+Z
      // can roll this toggle back. Clear the redo stack — once the user
      // takes a new action after undoing, the future timeline is invalid.
      const nextUndo = [...state.scheduleUndoStack, sch].slice(-SCHEDULE_HISTORY_MAX)

      const driverSchedules = sch.driverSchedules.map((ds) => {
        if (ds.driver.id !== driverId) return ds
        const days = ds.days.map((d) => {
          if (d.date !== date) return d
          const slots = [...d.slots]
          slots[slotIndex] = !slots[slotIndex]
          const totalHours = slots.reduce((s, on) => s + (on ? 1 : 0), 0)
          return { ...d, slots, totalHours, isOff: totalHours === 0 }
        })
        const weeklyHours: Record<string, number> = {}
        for (const di of sch.dates) {
          const e = days.find((d) => d.date === di.date)
          if (e) weeklyHours[di.weekLabel] = (weeklyHours[di.weekLabel] ?? 0) + e.totalHours
        }
        const totalHours = Object.values(weeklyHours).reduce((s, h) => s + h, 0)
        return { ...ds, days, weeklyHours, totalHours }
      })

      // Recount per-slot coverage from scratch. Shoppers are excluded
      // because they belong to a separate operational pool (groceries)
      // and don't count toward DRIVER coverage targets. Mirrors the
      // shopper-exclusion rule in scheduler.ts; without it, clicking
      // a slot in the day grid would inflate the coverage number with
      // shopper hours and the cell would visually flip from short/ok
      // to over.
      const newCov = new Array(slotCount).fill(0)
      for (const ds of driverSchedules) {
        if (ds.driver.isShopper) continue
        const e = ds.days.find((d) => d.date === date)
        if (!e) continue
        e.slots.forEach((on, i) => { if (on) newCov[i]++ })
      }
      return {
        schedule: {
          ...sch,
          driverSchedules,
          coverageActual: { ...sch.coverageActual, [date]: newCov },
        },
        scheduleUndoStack: nextUndo,
        scheduleRedoStack: [],
      }
    }),

  undoScheduleEdit: () => {
    const state = get()
    if (state.scheduleUndoStack.length === 0 || !state.schedule) return
    const undo = [...state.scheduleUndoStack]
    const prev = undo.pop()!
    set({
      schedule: prev,
      scheduleUndoStack: undo,
      // Save the current (post-edit) schedule onto the redo stack so the
      // user can Cmd/Ctrl+Shift+Z back into it.
      scheduleRedoStack: [...state.scheduleRedoStack, state.schedule].slice(-SCHEDULE_HISTORY_MAX),
    })
  },

  redoScheduleEdit: () => {
    const state = get()
    if (state.scheduleRedoStack.length === 0 || !state.schedule) return
    const redo = [...state.scheduleRedoStack]
    const next = redo.pop()!
    set({
      schedule: next,
      scheduleRedoStack: redo,
      scheduleUndoStack: [...state.scheduleUndoStack, state.schedule].slice(-SCHEDULE_HISTORY_MAX),
    })
  },

  canUndoScheduleEdit: () => get().scheduleUndoStack.length > 0,
  canRedoScheduleEdit: () => get().scheduleRedoStack.length > 0,

  hydrateFromSnapshot: (data) =>
    set((s) => ({
      step: data.schedule ? 'schedule' : 'names',
      drivers: data.drivers ?? [],
      startDate: data.startDate,
      endDate: data.endDate,
      fullTimeCap: data.fullTimeCap ?? DEFAULT_FULL_TIME_CAP,
      partTimeCap: data.partTimeCap ?? DEFAULT_PART_TIME_CAP,
      coverageScale: data.coverageScale ?? 1,
      coverageOverrides: data.coverageOverrides ?? {},
      minHoursPerDay: data.minHoursPerDay ?? 4,
      maxHoursPerDay: data.maxHoursPerDay ?? 9,
      timeOff: data.timeOff ?? {},
      absenceReasons: data.absenceReasons ?? {},
      weekendRotationOffset: data.weekendRotationOffset ?? s.weekendRotationOffset,
      schedule: data.schedule,
      scheduleUndoStack: [],
      scheduleRedoStack: [],
    })),

  importRotationContext: (data) =>
    set((s) => {
      const nextStart = addDays(data.endDate, 1)
      const nextEnd = addDays(nextStart, 6)
      return {
        drivers: data.drivers ?? s.drivers,
        fullTimeCap: data.fullTimeCap ?? s.fullTimeCap,
        partTimeCap: data.partTimeCap ?? s.partTimeCap,
        coverageScale: data.coverageScale ?? s.coverageScale,
        coverageOverrides: data.coverageOverrides ?? s.coverageOverrides,
        minHoursPerDay: data.minHoursPerDay ?? s.minHoursPerDay,
        maxHoursPerDay: data.maxHoursPerDay ?? s.maxHoursPerDay,
        weekendRotationOffset: data.weekendRotationOffset ?? s.weekendRotationOffset,
        startDate: nextStart,
        endDate: nextEnd,
      }
    }),

  reset: () =>
    // Keep weekendRotationOffset across resets — the cursor represents the
    // team's long-running rotation position, not per-schedule data.
    set({
      step: 'names',
      drivers: [],
      startDate: defaultStart,
      endDate: addDays(defaultStart, 6),
      fullTimeCap: DEFAULT_FULL_TIME_CAP,
      partTimeCap: DEFAULT_PART_TIME_CAP,
      coverageScale: 1,
      coverageOverrides: {},
      minHoursPerDay: 4,
      maxHoursPerDay: 9,
      timeOff: {},
      absenceReasons: {},
      schedule: null,
      scheduleUndoStack: [],
      scheduleRedoStack: [],
    }),
}), {
  name: 'driver-scheduler',
  storage: createJSONStorage(() => localStorage),
  // Bump when the persisted shape changes in a non-back-compat way.
  // The migrate fn drops incompatible data instead of corrupting state.
  version: 2,
  migrate: (persisted: unknown, fromVersion: number) => {
    // v1 only stored { weekendRotationOffset }. Anything older just gets
    // its rotation cursor preserved and the new fields default-initialize.
    if (fromVersion < 2 && persisted && typeof persisted === 'object') {
      const p = persisted as Partial<DriverSchedulerStore>
      return { weekendRotationOffset: p.weekendRotationOffset ?? 0 }
    }
    return persisted as Partial<DriverSchedulerStore>
  },
  // Snap stale persisted date ranges back to the next Thursday→Wednesday
  // cycle on hydration so the picker always opens on a sensible work
  // week instead of last month's. Only fires when the persisted endDate
  // has already passed — in-progress schedules (endDate today or later)
  // are left alone so ops doesn't lose context mid-cycle. Also clears
  // the persisted `schedule` in that case since it's now for a window
  // that no longer matches the picker — saves the user a confusing
  // "why does the schedule still show last week" moment.
  onRehydrateStorage: () => (state) => {
    if (!state) return
    const today = new Date().toISOString().slice(0, 10)
    if (state.endDate && state.endDate < today) {
      const start = nextThursday()
      state.startDate = start
      state.endDate = addDays(start, 6)
      state.schedule = null
      return
    }
    // Repair `coverageActual` in any persisted schedule that pre-dates
    // the Phase-9 shopper-exclusion fix. Old generations could have
    // bumped driver-coverage by 1 every time Phase-9 extended a shopper
    // shift backward into an opening slot — leaving cells visibly
    // "5/7" when only 4 drivers were actually there. Recount from
    // scratch from the per-driver slot bitmaps, excluding shoppers.
    // No-op when totals already match (the common case once the bug
    // stops generating bad data).
    const sch = state.schedule
    if (!sch || !Array.isArray(sch.driverSchedules)) return
    const recounted: Record<string, number[]> = {}
    for (const date of Object.keys(sch.coverageActual ?? {})) {
      const len = sch.coverageActual[date]?.length ?? 15
      const fresh = new Array(len).fill(0)
      for (const ds of sch.driverSchedules) {
        if (ds.driver.isShopper) continue
        const e = ds.days.find((d) => d.date === date)
        if (!e || e.isOff) continue
        e.slots.forEach((on, i) => { if (on) fresh[i]++ })
      }
      recounted[date] = fresh
    }
    state.schedule = { ...sch, coverageActual: recounted }
  },
  // Auto-save the full working set so refresh / browser close doesn't
  // nuke in-flight edits. Excludes the undo/redo stacks (they balloon
  // localStorage on long sessions and aren't useful after refresh
  // anyway — the user just lost the editor context for those edits).
  // Step is persisted so you land back where you left off.
  partialize: (state) => ({
    step: state.step,
    drivers: state.drivers,
    startDate: state.startDate,
    endDate: state.endDate,
    fullTimeCap: state.fullTimeCap,
    partTimeCap: state.partTimeCap,
    coverageScale: state.coverageScale,
    coverageOverrides: state.coverageOverrides,
    minHoursPerDay: state.minHoursPerDay,
    maxHoursPerDay: state.maxHoursPerDay,
    timeOff: state.timeOff,
    absenceReasons: state.absenceReasons,
    weekendRotationOffset: state.weekendRotationOffset,
    schedule: state.schedule,
  }),
}))
