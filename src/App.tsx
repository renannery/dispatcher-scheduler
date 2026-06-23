import { useEffect, useState } from 'react'

import { VersionFooter } from '@/components/VersionFooter'
import { DriverSchedulerPage } from '@/drivers/DriverSchedulerPage'
import { useDriverStore } from '@/drivers/store'
import { SchedulerPage } from '@/pages/SchedulerPage'
import { TeamChooser } from '@/pages/TeamChooser'
import { useSchedulerStore } from '@/store/schedulerStore'
import { cloudEnabled, fetchSavedSnapshot } from '@/utils/cloudStorage'
import type { DispatcherSnapshotData, DriverSnapshotData } from '@/utils/snapshot'

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

  // Auto-load the saved cloud schedule when the user lands on a team page
  // with no local state yet. If they already have a local roster or
  // schedule, we leave it alone so the cloud version doesn't clobber
  // in-flight work — the badge in the schedule page still surfaces the
  // saved version and offers a manual Save / Load.
  const hydrateDispatcher = useSchedulerStore((s) => s.hydrateFromSnapshot)
  const hydrateDriver = useDriverStore((s) => s.hydrateFromSnapshot)
  useEffect(() => {
    if (!team || !cloudEnabled) return
    // Read store state at trigger time so we don't re-fetch every time
    // the store mutates (we'd just hydrate ourselves on top of ourselves).
    const dispatcherStore = useSchedulerStore.getState()
    const driverStore = useDriverStore.getState()
    const empty = team === 'dispatchers'
      ? dispatcherStore.dispatchers.length === 0 && !dispatcherStore.schedule
      : driverStore.drivers.length === 0 && !driverStore.schedule
    if (!empty) return
    let cancelled = false
    fetchSavedSnapshot(team)
      .then((env) => {
        if (cancelled || !env) return
        if (team === 'dispatchers') hydrateDispatcher(env.data as DispatcherSnapshotData)
        else hydrateDriver(env.data as DriverSnapshotData)
      })
      .catch(() => {})
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
