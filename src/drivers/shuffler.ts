import { parseISO } from 'date-fns'

import type {
  DriverSchedule,
  DriverTimeOff,
  GeneratedDriverSchedule,
} from './types'

/**
 * Pattern-rotating shuffle. Takes an existing schedule and produces a new
 * one where DRIVER IDENTITIES are permuted across the existing pattern
 * blocks — same set of 14-day patterns, just attached to different
 * drivers. Per-slot coverage is invariant by construction (we move
 * `days` arrays as intact blocks), so the schedule's `coverageActual`
 * is reused as-is.
 *
 * Compatibility: a driver D can RECEIVE pattern P iff:
 *   - sum of P's daily hours per work-week ≤ D's weekly cap (FT 42, PT 28)
 *   - every active slot in every day of P falls outside D's per-date
 *     time-off bitmap AND D's recurring-weekly blocks (matches the
 *     `blockedBitmap` rule the scheduler uses)
 *   - D.isShopper === source-driver.isShopper (keep shoppers in their
 *     own pool — XLSX export groups by isShopper, mixing breaks layout)
 *
 * Rest, min-hours-per-day, and max-hours-per-day are AUTOMATICALLY
 * preserved because we move patterns as whole blocks — the pattern was
 * already legal when generated, and rest is a per-driver property of
 * consecutive days both moving together.
 *
 * Algorithm: seeded greedy pair-swap. Walk drivers in a randomized
 * order; for each unswapped driver, find the set of unswapped partners
 * who are mutually compatible for a 2-cycle (driver↔partner exchange
 * is legal in both directions). Pick a random one and swap them. If no
 * partner exists, the driver keeps their pattern. Per spec: "leave
 * them on their own pattern rather than producing an invalid result."
 */
export function shuffleDriverSchedules(
  schedule: GeneratedDriverSchedule,
  timeOff: DriverTimeOff,
  seed: number,
): GeneratedDriverSchedule {
  const ds = schedule.driverSchedules
  if (ds.length < 2) return schedule

  // Seed a deterministic PRNG so the same seed reproduces the same
  // shuffle. mulberry32 — small, fast, sufficient for this use.
  const rng = mulberry32(hash32(`shuffle:${seed}:${ds.length}`))

  // Build the "swap target" array — initially each driver keeps their
  // own index; we'll rewrite entries to point at the partner they swap
  // patterns with. After we finish, applyPermutation reads this map.
  const swapTo = ds.map((_, i) => i)
  const swapped = new Set<number>()

  // Per-driver derived view: weekly hours of the PATTERN they currently
  // hold (so we don't have to recompute when probing swap candidates).
  // weeklyHoursPerPattern[i] = { weekLabel → hours }. The pattern moving
  // to driver D must fit D's weekly cap on every week.
  const weeklyHoursPerPattern = ds.map((entry) => entry.weeklyHours)

  // Per (driver, pattern) compatibility predicate. Caches across the
  // pair-swap loop so we don't re-derive blocks repeatedly.
  const compatCache = new Map<string, boolean>()
  function canHold(driverIdx: number, patternIdx: number): boolean {
    if (driverIdx === patternIdx) return true  // identity is always valid
    const key = `${driverIdx}:${patternIdx}`
    const cached = compatCache.get(key)
    if (cached !== undefined) return cached
    const ok = computeCompatible(ds, timeOff, schedule, driverIdx, patternIdx)
    compatCache.set(key, ok)
    return ok
  }

  // Randomized iteration order so the first driver picked varies per seed.
  const order = shuffledIndices(ds.length, rng)

  for (const i of order) {
    if (swapped.has(i)) continue
    // Find all j ≠ i, unswapped, where i↔j pattern swap is legal both ways.
    const partners: number[] = []
    for (const j of order) {
      if (j === i || swapped.has(j)) continue
      // Both halves: i must be able to hold j's pattern AND j must be
      // able to hold i's pattern. If either fails, the 2-cycle breaks.
      if (canHold(i, j) && canHold(j, i)) partners.push(j)
    }
    if (partners.length === 0) {
      // No compatible swap partner — driver i stays on their own pattern.
      swapped.add(i)
      continue
    }
    const partner = partners[Math.floor(rng() * partners.length)]
    // i takes j's pattern, j takes i's pattern. swapTo[k] = "the pattern
    // that ends up assigned to driver k" — i.e. the source index.
    swapTo[i] = partner
    swapTo[partner] = i
    swapped.add(i)
    swapped.add(partner)
  }
  // Suppress unused-var warning on the cached view (helps if we later
  // want to enable longer-cycle swaps that DO need weekly-hours probes).
  void weeklyHoursPerPattern

  // Materialize the new schedule. For each driver-position k, the
  // pattern block (days + weeklyHours + totalHours) comes from source
  // index swapTo[k]. The driver identity stays at position k.
  const newDriverSchedules: DriverSchedule[] = ds.map((entry, k) => {
    const sourceIdx = swapTo[k]
    if (sourceIdx === k) return entry  // no swap, original reference
    const source = ds[sourceIdx]
    return {
      driver: entry.driver,
      // days array can be shared by reference — DriverDayEntry is
      // read-only after the scheduler emits it (UI only reads .slots).
      // We DO need to update each entry's `dayLabel`/`dayOfWeek` etc.
      // … but those are date-derived, identical across drivers for the
      // same date, so the source's days are already correct.
      days: source.days,
      weeklyHours: source.weeklyHours,
      totalHours: source.totalHours,
    }
  })

  return {
    ...schedule,
    seed,                        // record the shuffle seed for repro
    driverSchedules: newDriverSchedules,
    coverageActual: schedule.coverageActual,  // unchanged by definition
  }
}

/**
 * Returns true when `driver` (at index driverIdx in schedule.driverSchedules)
 * could legally take over the pattern currently held by `source` (at
 * patternIdx). Mirrors the constraints from generateDriverSchedule's
 * candidate filter — except rest/min-hours/max-hours-per-day are
 * automatic (pattern moves as a block; rest depends on the pattern's
 * own internal day-to-day sequence which is unchanged).
 */
function computeCompatible(
  ds: DriverSchedule[],
  timeOff: DriverTimeOff,
  schedule: GeneratedDriverSchedule,
  driverIdx: number,
  patternIdx: number,
): boolean {
  const driver = ds[driverIdx].driver
  const source = ds[patternIdx]

  // 1. Employment type / shopper segregation. The scheduler enforces
  //    weekly caps per type AND treats shoppers as a separate pool —
  //    swapping across types would put a PT on a 42h pattern (illegal)
  //    or a non-shopper on a Sunday-off pattern (operationally wrong).
  if (driver.employmentType !== source.driver.employmentType) return false
  if (!!driver.isShopper !== !!source.driver.isShopper) return false

  // 2. Weekly cap check. The new driver's cap depends on type — we
  //    compare against the pattern's per-week hours. fullTimeCap /
  //    partTimeCap live on the schedule itself.
  const cap = driver.employmentType === 'full'
    ? schedule.fullTimeCap
    : schedule.partTimeCap
  for (const wkLabel of Object.keys(source.weeklyHours)) {
    if (source.weeklyHours[wkLabel] > cap) return false
  }

  // 3. Block check. For every active slot in every day of the pattern,
  //    the receiving driver must not have a time-off or recurring-block
  //    conflict. Reuses the same merge logic as scheduler.blockedBitmap
  //    so behavior is identical.
  for (const entry of source.days) {
    if (entry.isOff) continue
    const dateBm = timeOff[driver.id]?.[entry.date]
    const recurBm = driver.recurringBlocks?.[entry.dayOfWeek]
    if (!dateBm && !recurBm) continue
    for (let s = 0; s < entry.slots.length; s++) {
      if (!entry.slots[s]) continue
      if (dateBm?.[s] || recurBm?.[s]) return false
    }
  }

  return true
}

// ─── PRNG + helpers ─────────────────────────────────────────────────────

/** FNV-1a hash → 32-bit unsigned int, for seeding the PRNG. */
function hash32(str: string): number {
  let h = 2166136261
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** Mulberry32 — tiny seedable PRNG. Returns [0, 1). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) | 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Fisher-Yates shuffle of [0..n), using the supplied PRNG. */
function shuffledIndices(n: number, rng: () => number): number[] {
  const arr = Array.from({ length: n }, (_, i) => i)
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

// parseISO import isn't used directly — kept for future per-date probes
// (e.g. checking a specific date's coverage state during longer cycles).
void parseISO
