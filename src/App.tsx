import { useEffect, useState } from 'react'

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

  if (team === null) return <TeamChooser onPick={setTeam} />
  if (team === 'drivers') return <DriverSchedulerPage onChangeTeam={() => setTeam(null)} />
  return <SchedulerPage onChangeTeam={() => setTeam(null)} />
}
