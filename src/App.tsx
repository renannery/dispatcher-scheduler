import { useEffect, useState } from 'react'

import { VersionFooter } from '@/components/VersionFooter'
import { DriverSchedulerPage } from '@/drivers/DriverSchedulerPage'
import { useDriverStore } from '@/drivers/store'
import { SchedulerPage } from '@/pages/SchedulerPage'
import { TeamChooser } from '@/pages/TeamChooser'
import { useSchedulerStore } from '@/store/schedulerStore'

type Team = 'dispatchers' | 'drivers'
const STORAGE_KEY = 'scheduler.team'

export default function App() {
  const [team, setTeam] = useState<Team | null>(() => {
    const stored = localStorage.getItem(STORAGE_KEY)
    return stored === 'dispatchers' || stored === 'drivers' ? stored : null
  })

  useEffect(() => {
    if (team) localStorage.setItem(STORAGE_KEY, team)
    else localStorage.removeItem(STORAGE_KEY)
  }, [team])

  // Warn before unload when there's a non-trivial schedule in-flight.
  // localStorage auto-save protects MOST cases but a) browsers can hit
  // quota or fail silently, and b) the warning is good UX so the user
  // knows they're about to navigate away from real work. Browser-native
  // prompt — string returned is ignored by modern browsers, they show
  // their own generic message.
  const hasDriverWork = useDriverStore((s) =>
    !!s.schedule || s.drivers.length > 0,
  )
  const hasDispatcherWork = useSchedulerStore((s) =>
    !!s.schedule || s.dispatchers.length > 0,
  )
  useEffect(() => {
    const hasWork = hasDriverWork || hasDispatcherWork
    if (!hasWork) return
    const handler = (e: BeforeUnloadEvent) => {
      // Required for some browsers to show the prompt.
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [hasDriverWork, hasDispatcherWork])

  return (
    <div className="flex min-h-screen flex-col">
      <div className="flex-1">
        {team === null && <TeamChooser onPick={setTeam} />}
        {team === 'drivers' && <DriverSchedulerPage onChangeTeam={() => setTeam(null)} />}
        {team === 'dispatchers' && <SchedulerPage onChangeTeam={() => setTeam(null)} />}
      </div>
      <VersionFooter />
    </div>
  )
}
