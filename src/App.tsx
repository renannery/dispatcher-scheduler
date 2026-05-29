import { useEffect, useState } from 'react'

import { VersionFooter } from '@/components/VersionFooter'
import { DriverSchedulerPage } from '@/drivers/DriverSchedulerPage'
import { SchedulerPage } from '@/pages/SchedulerPage'
import { TeamChooser } from '@/pages/TeamChooser'

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
