import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

import { SLOTS } from '@/data/coverageTemplate'
import type { Dispatcher, DispatcherLevel, DispatcherTimeOff, GeneratedSchedule, Step } from '@/types/schedule'
import type { AbsenceReason } from '@/utils/absence'
import { datesInRange } from '@/utils/absence'
import type { DispatcherSnapshotData } from '@/utils/snapshot'

const DISPATCHER_COLORS = [
  '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
  '#06b6d4', '#ec4899', '#84cc16', '#f97316', '#6366f1',
  '#14b8a6', '#e11d48', '#7c3aed', '#0ea5e9', '#d97706',
]

function makeId() {
  return Math.random().toString(36).slice(2, 9)
}

function nextThursday(): string {
  const d = new Date()
  const day = d.getDay()
  // 4 = Thursday; if today IS Thursday, jump to next week's Thursday
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

interface SchedulerStore {
  step: Step
  dispatchers: Dispatcher[]
  startDate: string
  endDate: string
  timeOff: DispatcherTimeOff
  absenceReasons: AbsenceReasonMap
  /** Persisted weekend-off rotation cursor — see driver store comment. */
  weekendRotationOffset: number
  schedule: GeneratedSchedule | null

  setStep: (step: Step) => void
  addDispatcher: (name: string, level?: DispatcherLevel) => void
  removeDispatcher: (id: string) => void
  setDispatcherLevel: (id: string, level: DispatcherLevel) => void
  toggleRecurringBlock: (id: string, dayOfWeek: number, slotIndex: number) => void
  setRecurringBlocks: (id: string, blocks: boolean[][]) => void
  setDateRange: (start: string, end: string) => void
  advanceWeekendRotation: (weeks: number) => void
  toggleFullDayOff: (dispatcherId: string, date: string) => void
  toggleBlockedSlot: (dispatcherId: string, date: string, slotIndex: number) => void
  applyAbsenceRange: (
    dispatcherId: string,
    start: string,
    end: string,
    reason: AbsenceReason,
    slotMask?: boolean[],
  ) => void
  setSchedule: (s: GeneratedSchedule) => void
  toggleDispatcherSlot: (dispatcherId: string, date: string, slotIndex: number) => void
  hydrateFromSnapshot: (data: DispatcherSnapshotData) => void
  /**
   * Partial hydrate for the period step: pulls the roster + rotation cursor
   * from a previous schedule snapshot so the new period continues the
   * weekend-off rotation. Advances the date range to the week after the
   * snapshot's end. Leaves time-off / absence reasons / schedule alone.
   */
  importRotationContext: (data: DispatcherSnapshotData) => void
  reset: () => void
}

function makeFullBitmap(): boolean[] {
  return new Array(SLOTS.length).fill(true)
}
function isAllFalse(arr: boolean[] | undefined): boolean {
  return !arr || arr.every((v) => !v)
}
function isAllTrue(arr: boolean[] | undefined): boolean {
  return !!arr && arr.length === SLOTS.length && arr.every(Boolean)
}

export const useSchedulerStore = create<SchedulerStore>()(persist((set) => ({
  step: 'names',
  dispatchers: [],
  startDate: defaultStart,
  endDate: addDays(defaultStart, 6),
  timeOff: {},
  absenceReasons: {},
  weekendRotationOffset: 0,
  schedule: null,

  setStep: (step) => set({ step }),

  addDispatcher: (name, level = 'Regular') =>
    set((s) => {
      const trimmed = name.trim()
      if (!trimmed) return s
      if (s.dispatchers.some((d) => d.name.toLowerCase() === trimmed.toLowerCase())) return s
      const color = DISPATCHER_COLORS[s.dispatchers.length % DISPATCHER_COLORS.length]
      const next = [...s.dispatchers, { id: makeId(), name: trimmed, color, level }]
      next.sort((a, b) => a.name.localeCompare(b.name))
      return { dispatchers: next }
    }),

  setDispatcherLevel: (id, level) =>
    set((s) => ({
      dispatchers: s.dispatchers.map((d) => (d.id === id ? { ...d, level } : d)),
    })),

  toggleRecurringBlock: (id, dayOfWeek, slotIndex) =>
    set((s) => ({
      dispatchers: s.dispatchers.map((d) => {
        if (d.id !== id) return d
        const grid = d.recurringBlocks
          ? d.recurringBlocks.map((row) => [...row])
          : Array.from({ length: 7 }, () => new Array(SLOTS.length).fill(false))
        grid[dayOfWeek][slotIndex] = !grid[dayOfWeek][slotIndex]
        const empty = grid.every((row) => row.every((v) => !v))
        return { ...d, recurringBlocks: empty ? undefined : grid }
      }),
    })),

  setRecurringBlocks: (id, blocks) =>
    set((s) => ({
      dispatchers: s.dispatchers.map((d) => {
        if (d.id !== id) return d
        const empty = blocks.every((row) => row.every((v) => !v))
        return { ...d, recurringBlocks: empty ? undefined : blocks.map((row) => [...row]) }
      }),
    })),

  removeDispatcher: (id) =>
    set((s) => ({
      dispatchers: s.dispatchers.filter((d) => d.id !== id),
      timeOff: Object.fromEntries(Object.entries(s.timeOff).filter(([k]) => k !== id)),
      absenceReasons: Object.fromEntries(Object.entries(s.absenceReasons).filter(([k]) => k !== id)),
    })),

  setDateRange: (startDate, endDate) => set({ startDate, endDate }),

  advanceWeekendRotation: (weeks) =>
    set((s) => ({ weekendRotationOffset: s.weekendRotationOffset + Math.max(0, Math.floor(weeks)) })),

  toggleFullDayOff: (dispatcherId, date) =>
    set((s) => {
      const map = { ...(s.timeOff[dispatcherId] ?? {}) }
      const reasonMap = { ...(s.absenceReasons[dispatcherId] ?? {}) }
      const existing = map[date]
      if (isAllTrue(existing)) {
        delete map[date]
        delete reasonMap[date]
      } else {
        map[date] = makeFullBitmap()
      }
      return {
        timeOff: { ...s.timeOff, [dispatcherId]: map },
        absenceReasons: { ...s.absenceReasons, [dispatcherId]: reasonMap },
      }
    }),

  toggleBlockedSlot: (dispatcherId, date, slotIndex) =>
    set((s) => {
      const map = { ...(s.timeOff[dispatcherId] ?? {}) }
      const reasonMap = { ...(s.absenceReasons[dispatcherId] ?? {}) }
      const existing = map[date] ?? new Array(SLOTS.length).fill(false)
      const next = [...existing]
      next[slotIndex] = !next[slotIndex]
      if (isAllFalse(next)) {
        delete map[date]
        delete reasonMap[date]
      } else {
        map[date] = next
        // Reason persists for partial blocks too (Phase 2: hour-range absences).
      }
      return {
        timeOff: { ...s.timeOff, [dispatcherId]: map },
        absenceReasons: { ...s.absenceReasons, [dispatcherId]: reasonMap },
      }
    }),

  applyAbsenceRange: (dispatcherId, start, end, reason, slotMask) =>
    set((s) => {
      const map = { ...(s.timeOff[dispatcherId] ?? {}) }
      const reasonMap = { ...(s.absenceReasons[dispatcherId] ?? {}) }
      for (const date of datesInRange(start, end)) {
        if (slotMask) {
          const existing = map[date] ?? new Array(SLOTS.length).fill(false)
          map[date] = existing.map((on, i) => on || !!slotMask[i])
        } else {
          map[date] = makeFullBitmap()
        }
        reasonMap[date] = reason
      }
      return {
        timeOff: { ...s.timeOff, [dispatcherId]: map },
        absenceReasons: { ...s.absenceReasons, [dispatcherId]: reasonMap },
      }
    }),

  setSchedule: (schedule) => set({ schedule }),

  toggleDispatcherSlot: (dispatcherId, date, slotIndex) =>
    set((state) => {
      if (!state.schedule) return state
      const sch = state.schedule
      const slotCount = SLOTS.length

      const dispatcherSchedules = sch.dispatcherSchedules.map((ds) => {
        if (ds.dispatcher.id !== dispatcherId) return ds
        const days = ds.days.map((d) => {
          if (d.date !== date) return d
          const slots = [...d.slots]
          slots[slotIndex] = !slots[slotIndex]
          // Dispatcher slots have variable durations (0.5h or 1h); weight accordingly.
          const totalHours = slots.reduce((s, on, i) => s + (on ? SLOTS[i].hours : 0), 0)
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
      for (const ds of dispatcherSchedules) {
        const e = ds.days.find((d) => d.date === date)
        if (!e) continue
        e.slots.forEach((on, i) => { if (on) newCov[i]++ })
      }
      return {
        schedule: {
          ...sch,
          dispatcherSchedules,
          coverageActual: { ...sch.coverageActual, [date]: newCov },
        },
      }
    }),

  hydrateFromSnapshot: (data) =>
    set((s) => ({
      step: data.schedule ? 'schedule' : 'names',
      dispatchers: data.dispatchers ?? [],
      startDate: data.startDate,
      endDate: data.endDate,
      timeOff: data.timeOff ?? {},
      absenceReasons: data.absenceReasons ?? {},
      weekendRotationOffset: data.weekendRotationOffset ?? s.weekendRotationOffset,
      schedule: data.schedule,
    })),

  importRotationContext: (data) =>
    set((s) => {
      const nextStart = addDays(data.endDate, 1)
      const nextEnd = addDays(nextStart, 6)
      return {
        dispatchers: data.dispatchers ?? s.dispatchers,
        weekendRotationOffset: data.weekendRotationOffset ?? s.weekendRotationOffset,
        startDate: nextStart,
        endDate: nextEnd,
      }
    }),

  reset: () =>
    set({
      step: 'names',
      dispatchers: [],
      startDate: defaultStart,
      endDate: addDays(defaultStart, 6),
      timeOff: {},
      absenceReasons: {},
      schedule: null,
    }),
}), {
  name: 'dispatcher-scheduler',
  storage: createJSONStorage(() => localStorage),
  // v2: persist full working set (was just weekendRotationOffset). Refresh
  // / browser close no longer drops in-flight schedule edits.
  version: 2,
  migrate: (persisted: unknown, fromVersion: number) => {
    if (fromVersion < 2 && persisted && typeof persisted === 'object') {
      const p = persisted as Partial<SchedulerStore>
      return { weekendRotationOffset: p.weekendRotationOffset ?? 0 }
    }
    return persisted as Partial<SchedulerStore>
  },
  partialize: (state) => ({
    dispatchers: state.dispatchers,
    startDate: state.startDate,
    endDate: state.endDate,
    timeOff: state.timeOff,
    absenceReasons: state.absenceReasons,
    weekendRotationOffset: state.weekendRotationOffset,
    schedule: state.schedule,
  }),
}))
