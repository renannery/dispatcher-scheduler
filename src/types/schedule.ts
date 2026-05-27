// ---------------------------------------------------------------------------
// Core time-slot types
// ---------------------------------------------------------------------------

export interface TimeSlot {
  label: string    // "8-9 AM"
  hours: number    // 1 or 0.5
}

/** Per-day-of-week coverage template (0=Sun … 6=Sat). */
export interface DayTemplate {
  dayOfWeek: number
  dayName: string
  slots: TimeSlot[]
  /** Required number of dispatchers per slot index */
  requiredCoverage: number[]
  /**
   * Canonical shift patterns extracted from the reference Excel.
   * Each pattern = boolean array [numSlots], true = working that slot.
   * Ordered from earliest to latest.
   */
  /** 1 = working that slot, 0 = not working */
  shiftPatterns: number[][]
}

// ---------------------------------------------------------------------------
// Schedule output types
// ---------------------------------------------------------------------------

export type DispatcherLevel = 'Trainee' | 'Regular' | 'Senior'

export interface Dispatcher {
  id: string
  name: string
  color: string
  level: DispatcherLevel
}

export interface DispatcherDayEntry {
  date: string        // "YYYY-MM-DD"
  dayLabel: string    // "Thu May 28"
  dayOfWeek: number
  /** true = working that slot, false = off */
  slots: boolean[]
  totalHours: number
  isOff: boolean      // whole day off
}

export interface DispatcherSchedule {
  dispatcher: Dispatcher
  days: DispatcherDayEntry[]
  weeklyHours: Record<string, number>  // weekLabel -> hours
  totalHours: number
}

export interface GeneratedSchedule {
  startDate: string
  endDate: string
  /** Ordered date info for column headers */
  dates: { date: string; dayLabel: string; weekLabel: string; dayOfWeek: number }[]
  dispatcherSchedules: DispatcherSchedule[]
  /** Actual coverage achieved per date per slot (for coverage row) */
  coverageActual: Record<string, number[]>
}

export type Step = 'names' | 'period' | 'schedule'
