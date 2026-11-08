import { useEffect, useRef, useState } from 'react'

import styles from './App.module.css'
import TabBar, { type TabKey } from './ui/components/TabBar'
import TodayPage from './ui/pages/TodayPage'
import HistoryPage from './ui/pages/HistoryPage'
import ReadingPage from './ui/pages/ReadingPage'
import StatsPage from './ui/pages/StatsPage'
import SettingsPage from './ui/pages/SettingsPage'
import { loadLookupSettings } from '@/data/dict'
import { loadSettings } from '@/data/settings'
import { useLlm } from '@/store/llm'
import { useSession } from '@/store/session'
import { useTheme } from '@/store/theme'
import { useToast } from '@/store/toast'

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

  /** 每个栏目各自的滚动位置。所有页面共用一个滚动容器，不记就会串。 */
  const scrollMemory = useRef<Partial<Record<TabKey, number>>>({})
  const bodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void load()
    void loadLlm()
    void loadLookupSettings()
    void loadSettings()
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

  // Android 返回：根层级不再拦截（见 capacitor.config.ts 的 disableBackButtonHandler），
  // 系统直接播预测性「返回主页」动画，松手 app 退后台；子视图由 PredictiveBackPlugin 接管。
  // 原来的「连按两次退出」随之移除。

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
          {visited.has('stats') && <StatsPage active={tab === 'stats'} />}
        </div>
        <div className={styles.slot} data-active={tab === 'settings'}>
          {visited.has('settings') && <SettingsPage />}
        </div>
      </div>

      <TabBar value={tab} onChange={changeTab} />

      {toast && (
        <div className={styles.toast} role="status" onClick={clearToast}>
          {toast}
        </div>
      )}
    </div>
  )
}
