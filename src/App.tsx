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
import { loadLookupSettings } from '@/data/dict'
import { useLlm } from '@/store/llm'
import { useSession } from '@/store/session'
import { handleBack } from '@/store/backstack'
import { useTheme } from '@/store/theme'
import { useToast } from '@/store/toast'

const EXIT_CONFIRM_MS = 2200

export default function App() {
  const [tab, setTab] = useState<TabKey>('today')
  /**
   * 去过的栏目。第一次进入时才挂载，之后一直留着 ——
   * 这样切走再回来，阅读进度、译文开关、正在生成的请求都还在。
   * 不一次性全挂载，是为了别让统计页的图表在 0 尺寸的容器里初始化。
   */
  const [visited, setVisited] = useState<Set<TabKey>>(() => new Set<TabKey>(['today']))

  const load = useSession((s) => s.load)
  const loadLlm = useLlm((s) => s.load)
  const loadTheme = useTheme((s) => s.load)

  const toast = useToast((s) => s.message)
  const clearToast = useToast((s) => s.clear)

  const [exitHint, setExitHint] = useState(false)
  const lastBackRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  /** 每个栏目各自的滚动位置。所有页面共用一个滚动容器，不记就会串。 */
  const scrollMemory = useRef<Partial<Record<TabKey, number>>>({})
  const bodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void load()
    void loadLlm()
    void loadLookupSettings()
    void loadTheme()
  }, [load, loadLlm, loadTheme])

  function changeTab(next: TabKey) {
    if (next === tab) return

    const body = bodyRef.current
    if (body) scrollMemory.current[tab] = body.scrollTop

    setTab(next)
    setVisited((prev) => (prev.has(next) ? prev : new Set(prev).add(next)))
  }

  // 切回来时恢复该栏目上次的滚动位置。
  // 必须在 DOM 切换之后设置：滚动容器的高度刚刚变过，浏览器已经把 scrollTop 夹过了。
  useEffect(() => {
    const body = bodyRef.current
    if (!body) return

    body.scrollTop = scrollMemory.current[tab] ?? 0

    // 图表是在挂载时按当时的尺寸初始化的，切走期间尺寸变过，回来要它重新量一次
    const raf = requestAnimationFrame(() => window.dispatchEvent(new Event('resize')))
    return () => cancelAnimationFrame(raf)
  }, [tab])

  // Android 返回键：连按两次才退出，防止误触
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return

    let sub: { remove: () => void } | undefined

    void CapApp.addListener('backButton', () => {
      // 页面里有子视图（文章库、词卡）时先退一层，别直接弹退出
      if (handleBack()) return

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

  // 退出提示优先于普通提示，避免叠两条
  const toastText = exitHint ? '再按一次返回键退出' : toast

  return (
    <div className={styles.app}>
      <div className={styles.body} ref={bodyRef} data-scroller>
        <div className={styles.slot} data-active={tab === 'today'}>
          {visited.has('today') && <TodayPage onGoSettings={() => changeTab('settings')} />}
        </div>
        <div className={styles.slot} data-active={tab === 'history'}>
          {visited.has('history') && <HistoryPage />}
        </div>
        <div className={styles.slot} data-active={tab === 'reading'}>
          {visited.has('reading') && (
            <ReadingPage
              onGoSettings={() => changeTab('settings')}
              active={tab === 'reading'}
            />
          )}
        </div>
        <div className={styles.slot} data-active={tab === 'stats'}>
          {visited.has('stats') && <StatsPage />}
        </div>
        <div className={styles.slot} data-active={tab === 'settings'}>
          {visited.has('settings') && <SettingsPage />}
        </div>
      </div>

      <TabBar value={tab} onChange={changeTab} />

      {toastText && (
        <div
          className={styles.toast}
          role="status"
          onClick={exitHint ? undefined : clearToast}
        >
          {toastText}
        </div>
      )}
    </div>
  )
}
