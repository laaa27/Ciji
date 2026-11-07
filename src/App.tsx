import { useEffect, useState } from 'react'

import styles from './App.module.css'
import TabBar, { type TabKey } from './ui/components/TabBar'
import TodayPage from './ui/pages/TodayPage'
import HistoryPage from './ui/pages/HistoryPage'
import StatsPage from './ui/pages/StatsPage'
import SettingsPage from './ui/pages/SettingsPage'
import { loadLookupSettings } from './data/dict'
import { useSession } from './store/session'

export default function App() {
  const [tab, setTab] = useState<TabKey>('today')
  const load = useSession((s) => s.load)

  useEffect(() => {
    void load()
    void loadLookupSettings()
  }, [load])

  return (
    <div className={styles.app}>
      <div className={styles.body}>
        {tab === 'today' && <TodayPage onGoSettings={() => setTab('settings')} />}
        {tab === 'history' && <HistoryPage />}
        {tab === 'stats' && <StatsPage />}
        {tab === 'settings' && <SettingsPage />}
      </div>
      <TabBar value={tab} onChange={setTab} />
    </div>
  )
}
