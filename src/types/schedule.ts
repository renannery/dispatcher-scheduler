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
   *  be satisfied. Rendered as inline chips on the affected day, styled
   *  by `peak` kind (amber anchor / orange transition / red rest /
   *  sky handoff).
   *    - `lunch` / `dinner`: no continuity anchor for that peak.
   *    - `transition`: 1-slot dip the smoothing pass couldn't close;
   *      `slotIndex` carries the dip's slot.
   *    - `mandatory-rest`: coverage left short because ≥1 dispatcher
   *      is on a locked weekly rest day; `slotIndex` carries the
   *      shorted slot (may repeat per shorted slot per day).
   *    - `handoff`: no morning dispatcher works through the 15:00
   *      handoff slot — the evening team would start cold. */
  coverageWarnings?: Record<
    string,
    {
      peak: 'lunch' | 'dinner' | 'transition' | 'mandatory-rest' | 'handoff' | 'constrained-shift' | 'envelope' | 'trainee-split' | 'supervision'
      reason: string
      slotIndex?: number
    }[]
  >
  /** PROVENANCE for trainee-supervision coverage — the exemption key.
   *
   *  Every slot the supervision pass ADDS (a Senior extended/placed beside a
   *  Trainee) is stamped here with who/when/why. The gates exempt ONLY slots on
   *  this list, matched on (date, slot, seniorId) — never by raising a
   *  tolerance or widening a category. Any over-coverage NOT carrying a mark
   *  still fails exactly as before; the per-gate negative tests prove it.
   *
   *  This is deliberately provenance, not a threshold: an imprecise exemption
   *  is how the "law-forced" flag once swallowed a real off-cap bug. */
  supervisionSlots?: Record<
    string,
    { slot: number; seniorId: string; traineeId: string; reason: string }[]
  >
  /** PROVENANCE for the 8–9 PM shoulder CONCESSION — the other exemption key.
   *
   *  Governance: the 8–9 PM shoulder may drop to 1 body (never below, never
   *  inside a peak, never a zero) when — and only when — that is what buys a
   *  Trainee a fully Senior-supervised window. Every such dip is stamped here
   *  with the Trainee window it bought and the Senior it freed, and is always
   *  flagged. An unmarked shoulder dip below target−1 is a hard failure.
   *
   *  Deliberately NOT merged into `supervisionSlots`: that list exempts
   *  over-coverage a Senior ADDS beside the Trainee, this one records
   *  under-coverage the schedule GAVE UP for her. Opposite signs, opposite
   *  gates — one list would let a gate excuse the wrong thing. */
  supervisionConcessions?: Record<
    string,
    { slot: number; seniorId: string; traineeId: string; coverage: number; required: number; reason: string }[]
  >
  /** Per-week record of the rotating 2nd-day-off perk: who was up in the
   *  rotation, whether the grant passed the feasibility bar (≤ +1
   *  under-target unit for the week, never inside a peak, never a
   *  0-coverage slot, depth ≤ 1), and why a skip happened. A skipped
   *  turn is DEFERRED — the same dispatcher stays up next week. */
  secondOffLog?: SecondOffRecord[]
}

export interface SecondOffRecord {
  weekLabel: string
  candidateId: string
  candidateName: string
  granted: boolean
  /** Granted day (yyyy-MM-dd) when granted. */
  date?: string
  /** Week under-target units delta vs the no-grant baseline. */
  unitDelta?: number
  /**
   * Set when this record flags a LAW-FORCED extra day off (a 3rd for
   * Regular/Senior, a 2nd for Trainee) that the operational ≤-cap had to yield
   * to because mandatory rest + the ≤6-consecutive-workday rule leave no legal
   * lower-off arrangement that week. Not a grant — a surfaced, expected cap
   * exception, never a silent break.
   */
  forcedThirdOff?: boolean
  reason: string
}

export type Step = 'names' | 'period' | 'schedule'

/**
 * Per-dispatcher, per-date slot bitmap. `true` at index i means UNAVAILABLE
 * during slot i. All-true = full day off, empty/missing = fully available.
 */
export type DispatcherTimeOff = Record<string, Record<string, boolean[]>>
