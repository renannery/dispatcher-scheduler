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
  /**
   * Per day-of-week (0=Sun…6=Sat), bitmap of recurring blocked slots.
   * Travels with the dispatcher across schedules.
   */
  recurringBlocks?: boolean[][]
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
  /** Rotation seed used when generating; lets consumers reproduce the same
   *  weekend-off cycle the scheduler used. */
  seed: number
  /** Ordered date info for column headers */
  dates: { date: string; dayLabel: string; weekLabel: string; dayOfWeek: number }[]
  dispatcherSchedules: DispatcherSchedule[]
  /** Actual coverage achieved per date per slot (for coverage row) */
  coverageActual: Record<string, number[]>
  /** Effective required coverage per date (day-template baseline + per-day
   *  per-slot overrides). Lets the UI render the same numbers the scheduler
   *  used without re-deriving from the template. */
  coverageRequired?: Record<string, number[]>
  /** Non-blocking warnings the scheduler emits when a constraint can't
   *  be satisfied — e.g. no eligible continuity anchor for a peak. The
   *  UI surfaces these as inline badges on the affected day. */
  coverageWarnings?: Record<string, { peak: 'lunch' | 'dinner'; reason: string }[]>
}

export type Step = 'names' | 'period' | 'schedule'

/**
 * Per-dispatcher, per-date slot bitmap. `true` at index i means UNAVAILABLE
 * during slot i. All-true = full day off, empty/missing = fully available.
 */
export type DispatcherTimeOff = Record<string, Record<string, boolean[]>>
