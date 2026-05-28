import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

import type { AbsenceReason } from '@/utils/absence'
import { datesInRange } from '@/utils/absence'
import type { DriverSnapshotData } from '@/utils/snapshot'

import { DEFAULT_FULL_TIME_CAP, DEFAULT_PART_TIME_CAP, DRIVER_SLOTS } from './coverageTemplate'
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

  setStep: (step: DriverStep) => void
  addDriver: (name: string, employmentType?: EmploymentType) => void
  removeDriver: (id: string) => void
  setEmploymentType: (id: string, type: EmploymentType) => void
  setShopperStatus: (id: string, isShopper: boolean) => void
  toggleRecurringBlock: (id: string, dayOfWeek: number, slotIndex: number) => void
  setDateRange: (start: string, end: string) => void
  setFullTimeCap: (cap: number) => void
  setPartTimeCap: (cap: number) => void
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
  /** Replace entire store contents from a parsed snapshot. Jumps to the schedule step. */
  hydrateFromSnapshot: (data: DriverSnapshotData) => void
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

export const useDriverStore = create<DriverSchedulerStore>()(persist((set) => ({
  step: 'names',
  drivers: [],
  startDate: defaultStart,
  endDate: addDays(defaultStart, 6),
  fullTimeCap: DEFAULT_FULL_TIME_CAP,
  partTimeCap: DEFAULT_PART_TIME_CAP,
  timeOff: {},
  absenceReasons: {},
  weekendRotationOffset: 0,
  schedule: null,

  setStep: (step) => set({ step }),

  addDriver: (name, employmentType = 'full') =>
    set((s) => {
      const trimmed = name.trim()
      if (!trimmed) return s
      if (s.drivers.some((d) => d.name.toLowerCase() === trimmed.toLowerCase())) return s
      const color = DRIVER_COLORS[s.drivers.length % DRIVER_COLORS.length]
      const next = [...s.drivers, { id: makeId(), name: trimmed, color, employmentType }]
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

  removeDriver: (id) =>
    set((s) => ({
      drivers: s.drivers.filter((d) => d.id !== id),
      timeOff: Object.fromEntries(Object.entries(s.timeOff).filter(([k]) => k !== id)),
      absenceReasons: Object.fromEntries(Object.entries(s.absenceReasons).filter(([k]) => k !== id)),
    })),

  setDateRange: (startDate, endDate) => set({ startDate, endDate }),
  setFullTimeCap: (fullTimeCap) => set({ fullTimeCap }),
  setPartTimeCap: (partTimeCap) => set({ partTimeCap }),

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

  setSchedule: (schedule) => set({ schedule }),

  toggleDriverSlot: (driverId, date, slotIndex) =>
    set((state) => {
      if (!state.schedule) return state
      const sch = state.schedule
      const slotCount = sch.driverSchedules[0]?.days[0]?.slots.length ?? 15

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

      const newCov = new Array(slotCount).fill(0)
      for (const ds of driverSchedules) {
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
      }
    }),

  hydrateFromSnapshot: (data) =>
    set((s) => ({
      step: data.schedule ? 'schedule' : 'names',
      drivers: data.drivers ?? [],
      startDate: data.startDate,
      endDate: data.endDate,
      fullTimeCap: data.fullTimeCap ?? DEFAULT_FULL_TIME_CAP,
      partTimeCap: data.partTimeCap ?? DEFAULT_PART_TIME_CAP,
      timeOff: data.timeOff ?? {},
      absenceReasons: data.absenceReasons ?? {},
      weekendRotationOffset: data.weekendRotationOffset ?? s.weekendRotationOffset,
      schedule: data.schedule,
    })),

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
      timeOff: {},
      absenceReasons: {},
      schedule: null,
    }),
}), {
  name: 'driver-scheduler',
  storage: createJSONStorage(() => localStorage),
  // Only persist the long-running rotation cursor; everything else is
  // schedule-specific and can be re-derived or imported via JSON.
  partialize: (state) => ({ weekendRotationOffset: state.weekendRotationOffset }),
}))
