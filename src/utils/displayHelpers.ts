import { format } from 'date-fns'

/**
 * "8–9 AM" → "8am"; "11–11:30 AM" → "11am"; "11:30–12 PM" → "11:30am"; "12–1 PM" → "12pm".
 * Source labels use the period of the END time ("11:30–12 PM" because noon = 12 PM),
 * so we special-case the noon transition: if end is "12" with PM, the start is AM.
 */
export function shortHour(slotLabel: string): string {
  const m = slotLabel.match(/^([\d:]+)\s*[–-]\s*([\d:]+)\s*(AM|PM)/i)
  if (!m) return slotLabel
  const [, start, end, periodRaw] = m
  const period = periodRaw.toUpperCase()
  if (end === '12' && period === 'PM') return `${start}am`
  return `${start}${period.toLowerCase()}`
}

/** ISO date → "Fri, June 29th" */
export function longDay(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date + (date.includes('T') ? '' : 'T00:00:00')) : date
  return format(d, 'EEE, MMMM do')
}

/** Two ISO dates → "Jun 25 → Jul 29" (year omitted unless they differ). */
export function fmtRangeShort(startISO: string, endISO: string): string {
  const s = new Date(startISO + 'T00:00:00')
  const e = new Date(endISO + 'T00:00:00')
  const sameYear = s.getFullYear() === e.getFullYear()
  const fmt = sameYear ? 'MMM d' : 'MMM d, yyyy'
  return `${format(s, fmt)} → ${format(e, fmt)}`
}
