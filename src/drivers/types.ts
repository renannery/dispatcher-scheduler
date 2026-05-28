export type EmploymentType = 'full' | 'part'

export interface Driver {
  id: string
  name: string
  color: string
  employmentType: EmploymentType
  /**
   * Per day-of-week (0=Sun…6=Sat), bitmap of recurring blocked slots.
   * Travels with the driver, not the schedule — so "Bobby breaks at 3 PM
   * every weekday for the school pickup" gets entered once and re-applies
   * every week.
   */
  recurringBlocks?: boolean[][]
}

export interface DriverDayEntry {
  date: string
  dayLabel: string
  dayOfWeek: number
  slots: boolean[]
  totalHours: number
  isOff: boolean
}

export interface DriverSchedule {
  driver: Driver
  days: DriverDayEntry[]
  weeklyHours: Record<string, number>
  totalHours: number
}

export interface GeneratedDriverSchedule {
  startDate: string
  endDate: string
  fullTimeCap: number
  partTimeCap: number
  /** Rotation seed used when generating; lets consumers reproduce the same
   *  weekend-off cycle the scheduler used. */
  seed: number
  dates: { date: string; dayLabel: string; weekLabel: string; dayOfWeek: number }[]
  driverSchedules: DriverSchedule[]
  coverageActual: Record<string, number[]>
}

/**
 * Per-driver, per-date slot bitmap. `true` at index i means the driver is
 * UNAVAILABLE during slot i on that date. An all-true bitmap = full day off.
 * Empty / missing entry = fully available.
 */
export type DriverTimeOff = Record<string, Record<string, boolean[]>>

export type DriverStep = 'names' | 'period' | 'schedule'
