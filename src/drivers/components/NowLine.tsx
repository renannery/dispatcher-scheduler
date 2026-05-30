import { useEffect, useRef, useState } from 'react'

interface Props {
  /** The day-grid table to measure column positions against. */
  tableRef: React.RefObject<HTMLTableElement | null>
  /** Slot index whose hour-column the line falls into. */
  slotIdx: number
  /** Fractional offset within that hour-column (0.0 to 1.0). */
  minuteFrac: number
  /** Label shown above the line. Typically "NOW · 14:32". */
  label: string
}

/**
 * Vertical "current time" line absolutely-positioned inside the day-grid
 * wrapper. Measures the target <th>'s position via DOM (not CSS math)
 * because DriverDayGrid filters slots out of `visibleSlotIndices` when
 * there's no demand/staffing — the "9 AM column" might be the first
 * hour-column on a weekday but the second on a weekend (after the 8 AM
 * column). Measurement is bullet-proof against that filtering.
 *
 * Re-measures on window resize and on every tick (parent passes a fresh
 * label each minute, which triggers a re-render here).
 */
export function NowLine({ tableRef, slotIdx, minuteFrac, label }: Props) {
  // `leftPx` = pixel offset of the line within the table's bounding box.
  // null while we haven't measured yet (returns nothing → no flicker).
  const [leftPx, setLeftPx] = useState<number | null>(null)
  const [heightPx, setHeightPx] = useState<number | null>(null)
  // Internal version counter — bumped by ResizeObserver so the measure
  // effect re-runs even when props haven't changed.
  const [resizeTick, setResizeTick] = useState(0)
  const containerRef = useRef<HTMLDivElement | null>(null)

  // Re-measure whenever slotIdx/minuteFrac change OR a resize fires.
  useEffect(() => {
    const table = tableRef.current
    if (!table) return
    const th = table.querySelector<HTMLTableCellElement>(`th[data-slot="${slotIdx}"]`)
    if (!th) {
      setLeftPx(null)
      return
    }
    // offsetLeft is relative to the nearest positioned ancestor. The
    // table sits inside a `position: relative` wrapper (added in
    // DriverDayGrid), so `th.offsetLeft` is already the correct x in
    // the wrapper's coordinate space.
    const tableRect = table.getBoundingClientRect()
    const thRect = th.getBoundingClientRect()
    const x = (thRect.left - tableRect.left) + th.offsetWidth * minuteFrac
    setLeftPx(x + (table.offsetLeft))
    setHeightPx(table.offsetHeight)
  }, [tableRef, slotIdx, minuteFrac, resizeTick, label])

  // Watch the table for size changes (window resize, font load, etc.).
  useEffect(() => {
    const table = tableRef.current
    if (!table || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setResizeTick((t) => t + 1))
    ro.observe(table)
    return () => ro.disconnect()
  }, [tableRef])

  if (leftPx === null || heightPx === null) return null

  return (
    <div
      ref={containerRef}
      // `pointer-events: none` so the line never blocks the user from
      // clicking a cell underneath it (cell click toggles slots).
      // z-15 sits ABOVE body cells (z-0) but BELOW sticky headers
      // (z-20/z-30), so the sticky top row + sticky left/right columns
      // visually pass over the line — keeps the line feeling anchored
      // to the table body, not floating above the chrome.
      className="pointer-events-none absolute top-0"
      style={{
        left: `${leftPx}px`,
        height: `${heightPx}px`,
        zIndex: 15,
      }}
    >
      {/* The line itself — 2px blue with a soft glow. */}
      <div
        className="h-full w-0.5 bg-blue-500"
        style={{ boxShadow: '0 0 6px rgba(59, 130, 246, 0.65)' }}
      />
      {/* "NOW · HH:MM" label floats at the top of the line, centered
          on the line's x. Translates left -50% so the label is centered
          horizontally on the 2px line. */}
      <span
        className="absolute -translate-x-1/2 whitespace-nowrap rounded-md bg-blue-600 px-1.5 py-0.5 text-[10px] font-bold text-white shadow"
        style={{ top: '-18px', left: '1px' }}
      >
        {label}
      </span>
    </div>
  )
}
