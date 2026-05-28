import clsx from 'clsx'
import { RotateCcw, Sliders } from 'lucide-react'
import { useState } from 'react'

import { DRIVER_DAY_TEMPLATES, DRIVER_SLOTS, effectiveCoverage } from '../coverageTemplate'
import { shortHour } from '../utils'

interface Props {
  coverageScale: number
  coverageOverrides: Record<number, number[]>
  onSetOverride: (dayOfWeek: number, slotIndex: number, value: number) => void
  onReset: () => void
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const DAY_ORDER = [4, 5, 6, 0, 1, 2, 3]  // Thu-Wed work week order

export function CoverageGridEditor({ coverageScale, coverageOverrides, onSetOverride, onReset }: Props) {
  const [open, setOpen] = useState(false)
  const overrideCount = Object.keys(coverageOverrides).length

  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-4 py-2.5 text-sm font-medium text-slate-600 hover:text-slate-800"
      >
        <Sliders className="h-4 w-4" />
        Customize coverage targets
        {overrideCount > 0 && (
          <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-semibold text-blue-700">
            {overrideCount} day{overrideCount === 1 ? '' : 's'} overridden
          </span>
        )}
        <span className="ml-auto text-xs text-slate-400">{open ? 'hide' : 'show'}</span>
      </button>

      {open && (
        <div className="border-t border-slate-200 px-4 py-3">
          <p className="mb-3 text-xs text-slate-500">
            Edit the number of drivers needed in each hourly slot. The coverage scale ({coverageScale.toFixed(2)}×)
            still applies on top of your overrides. Empty cell = use baseline.
          </p>

          <div className="overflow-x-auto">
            <table className="min-w-full border-separate border-spacing-0 text-[11px]">
              <thead>
                <tr>
                  <th className="sticky left-0 z-10 bg-slate-50 px-2 py-1 text-left font-semibold text-slate-500">Day</th>
                  {DRIVER_SLOTS.map((slot, i) => (
                    <th key={i} className="min-w-[44px] px-1 py-1 text-center font-normal text-slate-500">
                      {shortHour(slot.label)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {DAY_ORDER.map((dow) => {
                  const baseline = DRIVER_DAY_TEMPLATES[dow].requiredCoverage
                  const override = coverageOverrides[dow]
                  const effective = effectiveCoverage(dow, coverageScale, coverageOverrides)
                  return (
                    <tr key={dow} className="border-t border-slate-100">
                      <td className="sticky left-0 z-10 bg-slate-50 px-2 py-1 font-semibold text-slate-700">
                        {DAY_NAMES[dow]}
                      </td>
                      {baseline.map((base, si) => {
                        const value = override?.[si] ?? base
                        const eff = effective[si]
                        const isOverridden = override && override[si] !== base
                        return (
                          <td key={si} className="px-0.5 py-1">
                            <input
                              type="number"
                              min={0}
                              max={999}
                              value={value}
                              onChange={(e) => onSetOverride(dow, si, Number(e.target.value) || 0)}
                              title={`Effective ${eff} after ${coverageScale.toFixed(2)}× scale · baseline ${base}`}
                              className={clsx(
                                'w-10 rounded border px-1 py-0.5 text-center text-[11px] tabular-nums outline-none transition',
                                isOverridden
                                  ? 'border-blue-300 bg-blue-50 text-blue-800 focus:ring-1 focus:ring-blue-300'
                                  : 'border-slate-200 bg-white text-slate-600 focus:ring-1 focus:ring-blue-200',
                              )}
                            />
                          </td>
                        )
                      })}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {overrideCount > 0 && (
            <div className="mt-3 flex justify-end">
              <button
                type="button"
                onClick={onReset}
                className="flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-2.5 py-1 text-[11px] font-medium text-slate-600 hover:bg-slate-100"
              >
                <RotateCcw className="h-3 w-3" />
                Reset to defaults
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
