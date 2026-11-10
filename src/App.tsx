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
import { restoreScroll } from '@/lib/scroll'
import { useLlm } from '@/store/llm'
import { useSession } from '@/store/session'
import { useToday } from '@/store/today'
import { readScroll, readTab, saveScroll, saveTab } from '@/store/ui'
import { handleBack } from '@/store/backstack'
import { useGlass } from '@/store/glass'
import { usePrefs } from '@/store/prefs'
import { useTheme } from '@/store/theme'
import { useToast } from '@/store/toast'
import { checkForUpdate, type ReleaseInfo } from '@/domain/update'
import UpdateSheet from './ui/components/UpdateSheet'

const EXIT_CONFIRM_MS = 2200

/** 回到前台时，数据超过这个岁数就静默重采一次 */
const RESUME_STALE_MS = 10 * 60 * 1000

export default function App() {
  // 上次停在哪个栏目 —— 从本地同步读，首帧就是对的，不会先闪一下「今日」
  const [tab, setTab] = useState<TabKey>(readTab)
  /**
   * 去过的栏目。第一次进入时才挂载，之后一直留着 ——
   * 这样切走再回来，阅读进度、译文开关、正在生成的请求都还在。
   * 不一次性全挂载，是为了别让统计页的图表在 0 尺寸的容器里初始化。
   */
  const [visited, setVisited] = useState<Set<TabKey>>(() => new Set<TabKey>([tab]))

  const load = useSession((s) => s.load)
  const loadLlm = useLlm((s) => s.load)
  const loadTheme = useTheme((s) => s.load)
  const loadGlass = useGlass((s) => s.load)
  const loadPrefs = usePrefs((s) => s.load)
  const hydrateToday = useToday((s) => s.hydrate)
  const glass = useGlass((s) => s.glass)

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
    void loadGlass()
    void loadPrefs()
    // 先把本地那份铺上，网络请求交给今日页自己触发 —— 请求失败也还有东西可看
    void hydrateToday()
  }, [load, loadLlm, loadTheme, loadGlass, loadPrefs, hydrateToday])

  // 检查更新：延迟 3 秒再查，别跟启动时的墨墨采集抢网络；
  // 查不到（断网/限流/没发新版本）静默跳过，绝不打扰
  const [update, setUpdate] = useState<ReleaseInfo | null>(null)
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void checkForUpdate().then((info) => {
        if (info) setUpdate(info)
      })
    }, 3000)
    return () => window.clearTimeout(timer)
  }, [])

  // 冷启动后把上次的滚动位置接回去。
  // 首帧时内容往往还没铺满（本地快照是异步读的），滚不到那么深，
  // 重试逻辑在 restoreScroll 里，与阅读页共用同一份。
  useEffect(() => {
    // 只在挂载时跑一次；切栏目由下面那个 effect 负责
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return restoreScroll(bodyRef.current, readScroll(tab))
  }, [])

  function changeTab(next: TabKey) {
    if (next === tab) return

    const body = bodyRef.current
    if (body) scrollMemory.current[tab] = body.scrollTop

    setTab(next)
    saveTab(next)
    setVisited((prev) => (prev.has(next) ? prev : new Set(prev).add(next)))
  }

  // 切回来时恢复该栏目上次的滚动位置。
  // 必须在 DOM 切换之后设置：滚动容器的高度刚刚变过，浏览器已经把 scrollTop 夹过了。
  useEffect(() => {
    const body = bodyRef.current
    if (!body) return

    body.scrollTop = scrollMemory.current[tab] ?? readScroll(tab)

    // 图表是在挂载时按当时的尺寸初始化的，切走期间尺寸变过，回来要它重新量一次
    const raf = requestAnimationFrame(() => window.dispatchEvent(new Event('resize')))
    return () => cancelAnimationFrame(raf)
  }, [tab])

  // 滚动停下就记一笔。切栏目时也会写，兼容「滚到一半就切走」的情况
  useEffect(() => {
    const body = bodyRef.current
    if (!body) return

    let timer = 0
    const onScroll = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        scrollMemory.current[tab] = body.scrollTop
        saveScroll(tab, body.scrollTop)
      }, 300)
    }

    body.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      body.removeEventListener('scroll', onScroll)
      window.clearTimeout(timer)
    }
  }, [tab])

  // Android 返回键：连按两次才收起应用（回桌面，不杀进程），防止误触
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return

    let sub: { remove: () => void } | undefined

    void CapApp.addListener('backButton', () => {
      // 页面里有子视图（文章库、词卡）时先退一层，别直接弹退出
      if (handleBack()) return

      const now = Date.now()
      if (now - lastBackRef.current < EXIT_CONFIRM_MS) {
        // 不退出进程：把任务移到后台，下次点图标能原样回来
        void CapApp.minimizeApp()
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

  // 回到前台：数据旧了就静默重采一次。
  // 之前没有任何前台恢复逻辑 —— 服务端一次抖动留下的错误卡片会一直挂着，
  // 用户看到的其实是几小时前的失败状态。
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return

    let sub: { remove: () => void } | undefined

    void CapApp.addListener('appStateChange', ({ isActive }) => {
      if (!isActive) return
      const today = useToday.getState()
      if (!today.snapshot || Date.now() - today.lastFetchAt > RESUME_STALE_MS) {
        void today.refresh()
      }
    }).then((s) => {
      sub = s
    })

    return () => sub?.remove()
  }, [])

  // 退出提示优先于普通提示，避免叠两条
  const toastText = exitHint ? '再按一次回到桌面' : toast

  return (
    <div className={styles.app} data-glass={glass}>
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

      {update && <UpdateSheet info={update} onClose={() => setUpdate(null)} />}

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
