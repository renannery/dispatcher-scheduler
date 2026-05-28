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
 * Short name written into column B of the exported XLSX. The backend matcher
 * does `db_driver.name.toLowerCase().includes(xlsxName.replaceAll('.','').toLowerCase())`,
 * so the XLSX string MUST be a substring of the DB driver's full name.
 *
 * Strategy:
 *   • Default to the first name — it's always a substring of "First …".
 *   • If that first name collides with another driver in the roster,
 *     disambiguate with the last name's initial ("Andre G." / "Andre K.")
 *     — both are substrings of "Andre Grant" / "Andre Kentish" respectively.
 *
 * Three-word names like "Annie Kay Gayle" or "Noli La Pena" specifically
 * BREAK with displayName()'s "first + last initial" form because "Annie G"
 * isn't a substring of "Annie Kay Gayle".
 */
export function xlsxName(fullName: string, allFullNames: string[]): string {
  const parts = fullName.split(/\s+/).filter(Boolean)
  if (parts.length === 0) return ''
  const first = parts[0]
  if (parts.length === 1) return first

  const firstLower = first.toLowerCase()
  const collisions = allFullNames.filter((n) => {
    const p = n.split(/\s+/).filter(Boolean)
    return p[0]?.toLowerCase() === firstLower
  }).length
  if (collisions <= 1) return first

  // Collision — use first + second word. This is a substring of every name
  // starting with "First Second…" and stays a substring for 3+ word names
  // (where "First L." would break, since "Annie G" isn't in "Annie Kay Gayle").
  return `${first} ${parts[1]}`
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
