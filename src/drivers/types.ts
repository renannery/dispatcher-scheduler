export type EmploymentType = 'full' | 'part'

export interface Driver {
  /** Client-side ID — used for React keys, store lookups, time-off maps. */
  id: string
  /**
   * Optional backend-system ID (e.g. Firestore document ID). When present,
   * the XLSX export emits this in column S so the backend can match drivers
   * by ID instead of by name — eliminates substring-match ambiguity for
   * common first names. Populated by the CSV import when the header
   * includes `driverId`.
   */
  driverId?: string
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
  /**
   * Hybrid role — primarily works the grocery store as a shopper and fills
   * in as a driver when the store is slow. The scheduler treats them like
   * any other driver, but the XLSX export groups them at the bottom of each
   * day-block (matching the reference layout the backend expects).
   */
  isShopper?: boolean
  /**
   * "Pending availability" — driver stays on the roster but is excluded
   * from the next generated schedule. Used for drivers whose availability
   * lands late in the week (Tue/Wed evening) after ops already needs to
   * publish. Once their availability arrives, ops flips this flag off and
   * the schedule view's "Confirm & add" action slots them in via
   * `addDriverIncremental` — no full regenerate, no churn to existing
   * assignments. Default unset = participates in generation as normal.
   */
  pendingAvailability?: boolean
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

/**
 * A slot the scheduler couldn't lift to the 40% coverage floor even with
 * its redistribution phases — meaning the gap is a genuine headcount
 * shortage (not just a distribution problem). Surfaced in a banner so ops
 * knows additional bodies are needed there, not algorithm tweaks.
 */
export interface HeadcountLimitedSlot {
  date: string
  /** Pretty day label, e.g. "Wed, June 3rd" — matches DriverDayEntry.dayLabel. */
  dayLabel: string
  /** Slot index 0..14, where 0 = 8 AM and 14 = 10 PM. */
  slotIndex: number
  /** Human label for the slot, e.g. "10 PM". */
  slotLabel: string
  /** Best coverage the scheduler achieved at this slot after all phases. */
  achieved: number
  /** Configured coverage target for this slot on this day. */
  target: number
  /** 40% floor for this slot — `ceil(target * 0.40)`. */
  floor: number
  /** Driver-hours short of the 40% floor. */
  hoursShortOfFloor: number
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
  /** Slots that finished below 40% floor AND no additional driver could
   *  legally be placed. Empty when every priority floor slot meets >=40%. */
  headcountLimitedSlots: HeadcountLimitedSlot[]
}

/**
 * Per-driver, per-date slot bitmap. `true` at index i means the driver is
 * UNAVAILABLE during slot i on that date. An all-true bitmap = full day off.
 * Empty / missing entry = fully available.
 */
export type DriverTimeOff = Record<string, Record<string, boolean[]>>

export type DriverStep = 'names' | 'period' | 'schedule'
