import { differenceInDays, format, parseISO } from 'date-fns'

import { useSchedulerStore } from '@/store/schedulerStore'
import { generateSchedule } from '@/utils/scheduler'

export function PeriodPicker() {
  const {
    dispatchers,
    startDate,
    endDate,
    timeOff,
    setDateRange,
    setSchedule,
    setStep,
    setTimeOff,
  } = useSchedulerStore()

  const totalDays = differenceInDays(parseISO(endDate), parseISO(startDate)) + 1
  const totalWeeks = Math.ceil(totalDays / 7)
  const isValid = startDate && endDate && endDate >= startDate && totalDays >= 7

  const handleGenerate = () => {
    if (!isValid) return
    const schedule = generateSchedule(dispatchers, startDate, endDate, timeOff)
    setSchedule(schedule)
    setStep('schedule')
  }

  // Build list of all dates in range for the time-off picker
  const allDates: { date: string; label: string }[] = []
  if (isValid) {
    const start = parseISO(startDate)
    for (let i = 0; i < totalDays; i++) {
      const d = new Date(start)
      d.setDate(d.getDate() + i)
      allDates.push({
        date: format(d, 'yyyy-MM-dd'),
        label: format(d, 'EEE M/d'),
      })
    }
  }

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-8">
      {/* Date range */}
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium text-slate-600">Schedule starts on</label>
          <input
            type="date"
            value={startDate}
            onChange={(e) => {
              const s = e.target.value
              setDateRange(s, endDate < s ? s : endDate)
            }}
            className="rounded-xl border border-slate-300 bg-white px-4 py-3 text-slate-800 shadow-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-200"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium text-slate-600">Schedule ends on</label>
          <input
            type="date"
            value={endDate}
            min={startDate}
            onChange={(e) => setDateRange(startDate, e.target.value)}
            className="rounded-xl border border-slate-300 bg-white px-4 py-3 text-slate-800 shadow-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-200"
          />
        </div>
      </div>

      {/* Period summary */}
      {isValid && (
        <div className="rounded-xl border border-blue-100 bg-blue-50 px-5 py-4 text-center">
          <div className="grid grid-cols-3 gap-4">
            <div>
              <div className="text-2xl font-bold text-blue-700">{totalDays}</div>
              <div className="text-xs text-blue-500">days</div>
            </div>
            <div>
              <div className="text-2xl font-bold text-blue-700">{totalWeeks}</div>
              <div className="text-xs text-blue-500">week{totalWeeks !== 1 ? 's' : ''}</div>
            </div>
            <div>
              <div className="text-2xl font-bold text-blue-700">≤40h</div>
              <div className="text-xs text-blue-500">per week</div>
            </div>
          </div>
          <p className="mt-3 text-xs text-blue-600">
            {format(parseISO(startDate), 'MMM d, yyyy')} → {format(parseISO(endDate), 'MMM d, yyyy')}
          </p>
          <p className="mt-1 text-xs text-blue-500">
            Mon–Fri: 9 AM – 11 PM · Sat–Sun: 8 AM – 11 PM · work week Thu → Wed
          </p>
        </div>
      )}

      {/* Time-off requests */}
      {isValid && (
        <div className="flex flex-col gap-3">
          <div>
            <h3 className="text-sm font-semibold text-slate-700">Time-off requests</h3>
            <p className="mt-0.5 text-xs text-slate-400">
              Mark days each dispatcher has requested off. Those days will be skipped in the generated schedule.
            </p>
          </div>
          {dispatchers.map((d) => {
            const offDates = new Set(timeOff[d.id] ?? [])
            return (
              <div key={d.id} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                <div className="mb-3 flex items-center gap-2">
                  <div
                    className="flex h-7 w-7 items-center justify-center rounded-full text-[11px] font-bold text-white"
                    style={{ backgroundColor: d.color }}
                  >
                    {d.name.split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase()}
                  </div>
                  <span className="text-sm font-medium text-slate-800">{d.name}</span>
                  {offDates.size > 0 && (
                    <span className="ml-auto rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-600">
                      {offDates.size} day{offDates.size !== 1 ? 's' : ''} off
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {allDates.map(({ date, label }) => {
                    const selected = offDates.has(date)
                    return (
                      <button
                        key={date}
                        onClick={() => {
                          const next = new Set(offDates)
                          if (next.has(date)) next.delete(date)
                          else next.add(date)
                          setTimeOff(d.id, [...next])
                        }}
                        className={[
                          'rounded-lg border px-2.5 py-1.5 text-xs font-medium transition',
                          selected
                            ? 'border-red-300 bg-red-50 text-red-700'
                            : 'border-slate-200 bg-slate-50 text-slate-600 hover:border-blue-300 hover:bg-blue-50',
                        ].join(' ')}
                      >
                        {label}
                      </button>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Actions */}
      <div className="flex justify-between pt-2">
        <button
          onClick={() => setStep('names')}
          className="rounded-xl border border-slate-300 px-5 py-3 text-sm font-medium text-slate-600 transition hover:bg-slate-50"
        >
          ← Back
        </button>
        <button
          disabled={!isValid}
          onClick={handleGenerate}
          className="rounded-xl bg-blue-600 px-8 py-3 text-sm font-semibold text-white shadow transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Generate Schedule →
        </button>
      </div>
    </div>
  )
}
