/**
 * Cayman Islands (UTC-05:00, no DST) is the operation's local timezone.
 * "Current time" in the UI must reflect Cayman wall-clock regardless of
 * where the admin is viewing from, so a manager in NY (DST) and one
 * locally both see the same "now" indicator at the same spot.
 *
 * Implementation uses `Intl.DateTimeFormat` with the IANA tz id
 * `America/Cayman`. Modern browsers + Node ≥ 14 support this. No DST
 * arithmetic on our side; the JS engine handles it.
 *
 * If we ever migrate to a DST-affected timezone, swap the constant.
 */
export const OPS_TIMEZONE = 'America/Cayman'

export interface CaymanNow {
  /** ISO date in YYYY-MM-DD, matches our schedule date keys exactly. */
  dateISO: string
  /** 24h hour (0-23) in Cayman local time. */
  hours: number
  /** Minutes within the hour (0-59) in Cayman local time. */
  minutes: number
}

/** Snapshot of Cayman local time at call time. Each call re-reads the
 *  system clock, so the result is current. Pure — no side effects. */
export function caymanNow(now: Date = new Date()): CaymanNow {
  // formatToParts so we can read year/month/day/hour/minute as strings
  // independently — avoids fragile string parsing of locale-dependent
  // date formats.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: OPS_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now)
  const get = (k: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === k)?.value ?? '00'
  return {
    dateISO: `${get('year')}-${get('month')}-${get('day')}`,
    hours: parseInt(get('hour'), 10),
    minutes: parseInt(get('minute'), 10),
  }
}

/** "2:32 PM" — Cayman local time, 12h am/pm format. Midnight renders as
 *  "12:00 AM", noon as "12:00 PM". Cheap to call every minute. */
export function caymanTimeLabel(now: Date = new Date()): string {
  const c = caymanNow(now)
  const period = c.hours >= 12 ? 'PM' : 'AM'
  const h12 = c.hours % 12 === 0 ? 12 : c.hours % 12
  return `${h12}:${String(c.minutes).padStart(2, '0')} ${period}`
}
