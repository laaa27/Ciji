import { useEffect, useRef, useState } from 'react'
import { App as CapApp } from '@capacitor/app'
import { Capacitor } from '@capacitor/core'

import styles from './App.module.css'
import TabBar, { type TabKey } from './ui/components/TabBar'
import TodayPage from './ui/pages/TodayPage'
import HistoryPage from './ui/pages/HistoryPage'
import ReadingPage from './ui/pages/ReadingPage'
import StatsPage from './ui/pages/StatsPage'
import SettingsPage from './ui/pages/SettingsPage'
import { loadLookupSettings } from './data/dict'
import { useLlm } from './store/llm'
import { useSession } from './store/session'
import { useTheme } from './store/theme'

const EXIT_CONFIRM_MS = 2200

export default function App() {
  const [tab, setTab] = useState<TabKey>('today')
  const load = useSession((s) => s.load)
  const loadLlm = useLlm((s) => s.load)
  const loadTheme = useTheme((s) => s.load)

  const [exitHint, setExitHint] = useState(false)
  const lastBackRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    void load()
    void loadLlm()
    void loadLookupSettings()
    void loadTheme()
  }, [load, loadLlm, loadTheme])

  // Android 返回键：连按两次才退出，防止误触
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return

    let sub: { remove: () => void } | undefined

    void CapApp.addListener('backButton', () => {
      const now = Date.now()
      if (now - lastBackRef.current < EXIT_CONFIRM_MS) {
        void CapApp.exitApp()
        return
      }
      lastBackRef.current = now
      setExitHint(true)
      clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => setExitHint(false), EXIT_CONFIRM_MS)
    }).then((s) => {
      sub = s
    })

    return () => {
      sub?.remove()
      clearTimeout(timerRef.current)
    }
  }, [])

  return (
    <div className={styles.app}>
      <div className={styles.body}>
        {tab === 'today' && <TodayPage onGoSettings={() => setTab('settings')} />}
        {tab === 'history' && <HistoryPage />}
        {tab === 'reading' && <ReadingPage onGoSettings={() => setTab('settings')} />}
        {tab === 'stats' && <StatsPage />}
        {tab === 'settings' && <SettingsPage />}
      </div>
      <TabBar value={tab} onChange={setTab} />

      {exitHint && (
        <div className={styles.toast} role="status">
          再按一次返回键退出
        </div>
      )}
    </div>
  )
}
