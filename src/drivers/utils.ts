import { format } from 'date-fns'

/** "Andre Grant" → "Andre G.", "Bobby" → "Bobby", "Juan Miguel Ico" → "Juan I." */
export function displayName(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean)
  if (parts.length === 0) return ''
  if (parts.length === 1) return parts[0]
  const last = parts[parts.length - 1]
  return `${parts[0]} ${last[0].toUpperCase()}.`
}

/**
 * "8–9 AM" → "8am"; "11–12 AM" → "11am"; "12–1 PM" → "12pm".
 * Special-cases the noon transition: source labels put the period on the END
 * time ("11:30–12 PM" because noon is 12 PM), so a "12 PM" end means AM start.
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

/** ISO date → "Jun 29" — compact alternative for tight spaces */
export function shortDay(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date + (date.includes('T') ? '' : 'T00:00:00')) : date
  return format(d, 'MMM d')
}
