import clsx from 'clsx'
import { Calendar, CheckCircle2, Users } from 'lucide-react'

import { DispatcherInput } from '@/components/DispatcherInput'
import { PeriodPicker } from '@/components/PeriodPicker'
import { ScheduleGrid } from '@/components/ScheduleGrid'
import { useSchedulerStore } from '@/store/schedulerStore'
import type { Step } from '@/types/schedule'

interface StepMeta {
  id: Step
  label: string
  description: string
  icon: React.ReactNode
}

const STEPS: StepMeta[] = [
  {
    id: 'names',
    label: 'Dispatchers',
    description: 'Who is on the team?',
    icon: <Users className="h-5 w-5" />,
  },
  {
    id: 'period',
    label: 'Period',
    description: 'When does the schedule run?',
    icon: <Calendar className="h-5 w-5" />,
  },
  {
    id: 'schedule',
    label: 'Schedule',
    description: 'Review & download',
    icon: <CheckCircle2 className="h-5 w-5" />,
  },
]

const STEP_ORDER: Step[] = ['names', 'period', 'schedule']

function StepBar({ current }: { current: Step }) {
  const currentIdx = STEP_ORDER.indexOf(current)
  return (
    <nav className="flex items-start gap-0">
      {STEPS.map((step, idx) => {
        const done = idx < currentIdx
        const active = idx === currentIdx
        const isLast = idx === STEPS.length - 1
        return (
          <div key={step.id} className="flex flex-1 items-start">
            <div className="flex flex-col items-center gap-1.5 flex-1">
              <div className="flex items-center w-full">
                {/* Left connector */}
                <div
                  className={clsx(
                    'h-0.5 flex-1 transition-colors',
                    idx === 0 ? 'invisible' : done || active ? 'bg-blue-500' : 'bg-slate-200',
                  )}
                />
                {/* Circle */}
                <div
                  className={clsx(
                    'flex h-9 w-9 shrink-0 items-center justify-center rounded-full border-2 transition-all',
                    active && 'border-blue-600 bg-blue-600 text-white shadow-md shadow-blue-200',
                    done && 'border-blue-500 bg-blue-500 text-white',
                    !active && !done && 'border-slate-300 bg-white text-slate-400',
                  )}
                >
                  {step.icon}
                </div>
                {/* Right connector */}
                <div
                  className={clsx(
                    'h-0.5 flex-1 transition-colors',
                    isLast ? 'invisible' : done ? 'bg-blue-500' : 'bg-slate-200',
                  )}
                />
              </div>
              <div className="text-center">
                <div
                  className={clsx(
                    'text-xs font-semibold',
                    active ? 'text-blue-700' : done ? 'text-blue-500' : 'text-slate-400',
                  )}
                >
                  {step.label}
                </div>
                <div className="text-[11px] text-slate-400 hidden sm:block">{step.description}</div>
              </div>
            </div>
          </div>
        )
      })}
    </nav>
  )
}

const STEP_TITLES: Record<Step, string> = {
  names: 'Who are your dispatchers?',
  period: 'When is this schedule for?',
  schedule: 'Your generated schedule',
}

const STEP_SUBTITLES: Record<Step, string> = {
  names: 'Add each dispatcher\'s name. You can paste a comma-separated list to add multiple at once.',
  period: 'Choose the date range and shift configuration. The system will respect a 40-hour weekly maximum.',
  schedule: 'Review the proposed schedule. Expand any day to see the slot-level grid, then download your XLS.',
}

interface Props {
  onChangeTeam: () => void
}

export function SchedulerPage({ onChangeTeam }: Props) {
  const { step, reset, dispatchers, schedule } = useSchedulerStore()

  return (
    <div className="min-h-screen bg-slate-100">
      {/* Header */}
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-600 shadow-sm">
              <Calendar className="h-5 w-5 text-white" />
            </div>
            <div>
              <h1 className="text-base font-bold text-slate-900 leading-tight">Dispatcher Scheduler</h1>
              <p className="text-xs text-slate-500">Weekly schedule generator</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={onChangeTeam}
              className="text-xs text-slate-400 underline transition hover:text-blue-600"
            >
              Switch team
            </button>
            {(step !== 'names' || dispatchers.length > 0) && (
              <button
                onClick={reset}
                className="text-xs text-slate-400 underline transition hover:text-red-500"
              >
                Start over
              </button>
            )}
          </div>
        </div>
      </header>

      <main
        className={clsx(
          'mx-auto px-6 py-10',
          // Wider on the schedule step so the day grid uses the viewport
          // on large monitors; forms stay narrow for readability.
          step === 'schedule' ? 'max-w-[1600px]' : 'max-w-3xl',
        )}
      >
        {/* Step bar */}
        <div className="mb-10">
          <StepBar current={step} />
        </div>

        {/* Step heading */}
        <div className="mb-8">
          <h2 className="text-2xl font-bold text-slate-900">{STEP_TITLES[step]}</h2>
          <p className="mt-1.5 text-slate-500">{STEP_SUBTITLES[step]}</p>
        </div>

        <div>
          {step === 'names' && <DispatcherInput />}
          {step === 'period' && <PeriodPicker />}
          {step === 'schedule' && schedule && <ScheduleGrid />}
        </div>
      </main>
    </div>
  )
}
