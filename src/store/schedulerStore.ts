import { create } from 'zustand'

import type { Dispatcher, DispatcherLevel, GeneratedSchedule, Step } from '@/types/schedule'

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

interface TimeOffState {
  [dispatcherId: string]: string[] // "YYYY-MM-DD"[]
}

interface SchedulerStore {
  step: Step
  dispatchers: Dispatcher[]
  startDate: string
  endDate: string
  timeOff: TimeOffState
  schedule: GeneratedSchedule | null

  setStep: (step: Step) => void
  addDispatcher: (name: string, level?: DispatcherLevel) => void
  removeDispatcher: (id: string) => void
  setDispatcherLevel: (id: string, level: DispatcherLevel) => void
  setDateRange: (start: string, end: string) => void
  setTimeOff: (dispatcherId: string, dates: string[]) => void
  setSchedule: (s: GeneratedSchedule) => void
  reset: () => void
}

export const useSchedulerStore = create<SchedulerStore>((set) => ({
  step: 'names',
  dispatchers: [],
  startDate: defaultStart,
  endDate: addDays(defaultStart, 6),
  timeOff: {},
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

  removeDispatcher: (id) =>
    set((s) => ({
      dispatchers: s.dispatchers.filter((d) => d.id !== id),
      timeOff: Object.fromEntries(Object.entries(s.timeOff).filter(([k]) => k !== id)),
    })),

  setDateRange: (startDate, endDate) => set({ startDate, endDate }),

  setTimeOff: (dispatcherId, dates) =>
    set((s) => ({ timeOff: { ...s.timeOff, [dispatcherId]: dates } })),

  setSchedule: (schedule) => set({ schedule }),

  reset: () =>
    set({
      step: 'names',
      dispatchers: [],
      startDate: defaultStart,
      endDate: addDays(defaultStart, 6),
      timeOff: {},
      schedule: null,
    }),
}))
