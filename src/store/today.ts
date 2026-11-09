import { create } from 'zustand'

import { ApiError } from '@/api/client'
import { saveDay, getDay } from '@/data/store'
import { collectToday, type TodaySnapshot } from '@/domain/collect'
import { dateKey } from '@/lib/date'

type Status = 'idle' | 'loading' | 'ok' | 'error'

/**
 * 上一次失败的现场。
 *
 * 只为了让界面能展开看「到底是 HTTP 500 还是 200 带错误信封」——
 * 这两者的定性完全不同，而界面文案是同一句。
 */
export type ApiFailureDetail = {
  status?: number
  code?: string
  raw?: string
}

/** 同一次会话里，这个间隔内的重复刷新直接忽略（挡住切栏目、重挂载之类的抖动） */
const FRESH_MS = 60_000

type TodayState = {
  snapshot: TodaySnapshot | null
  status: Status
  error: string | null
  /** 上次失败的原始信息，给界面「详情」用 */
  errorDetail: ApiFailureDetail | null
  /** 正在联网刷新。有旧数据时也用它，界面不整页变「读取中」 */
  refreshing: boolean
  /** 上次成功联网的时刻；0 表示本次会话还没成功过 */
  lastFetchAt: number

  /** 只读本地：把今天已落盘的那份先铺上，不联网 */
  hydrate: () => Promise<void>
  /** 拉一次今天的数据。force=false 时若刚拉过则跳过 */
  refresh: (force?: boolean) => Promise<void>
  /** 只从本地库重读今天，不发请求。导入数据后用它刷新界面 */
  loadFromStorage: () => Promise<void>
  /** 清空（换 token 时调用） */
  reset: () => void
}

export const useToday = create<TodayState>((set, get) => ({
  snapshot: null,
  status: 'idle',
  error: null,
  errorDetail: null,
  refreshing: false,
  lastFetchAt: 0,

  hydrate: async () => {
    if (get().snapshot) return

    const snap = await getDay(dateKey())
    // 读盘期间可能已经联网成功了，别把新的盖掉
    if (!snap || get().snapshot) return

    // 已经失败过就保留错误，只是把本地数据补上来 —— 界面会「有数据 + 一条重试提示」
    set({ snapshot: snap, status: get().status === 'error' ? 'error' : 'ok' })
  },

  refresh: async (force = false) => {
    const { status, refreshing, lastFetchAt, snapshot } = get()
    if (refreshing || status === 'loading') return
    // 判断依据是「这次会话拉成功过没有」，不是「本地有没有数据」：
    // 否则启动读到的本地快照会让网络请求永远发不出去
    if (!force && lastFetchAt > 0 && Date.now() - lastFetchAt < FRESH_MS) return

    // 有旧数据就保持 'ok'，只把 refreshing 置起来，避免整页闪成「读取中」
    set({
      status: snapshot ? 'ok' : 'loading',
      refreshing: true,
      error: null,
      errorDetail: null,
    })

    try {
      const next = await collectToday()
      // 每次都落盘；同一天重复采集直接覆盖，保证幂等
      await saveDay(next)
      set({
        snapshot: next,
        status: 'ok',
        error: null,
        errorDetail: null,
        refreshing: false,
        lastFetchAt: Date.now(),
      })
    } catch (e) {
      set({
        status: 'error',
        refreshing: false,
        error: e instanceof Error ? e.message : '采集失败，请稍后重试',
        errorDetail:
          e instanceof ApiError ? { status: e.status, code: e.code, raw: e.raw } : null,
      })
    }
  },

  loadFromStorage: async () => {
    const snap = await getDay(dateKey())
    if (snap) set({ snapshot: snap, status: 'ok', error: null })
  },

  reset: () =>
    set({
      snapshot: null,
      status: 'idle',
      error: null,
      errorDetail: null,
      refreshing: false,
      lastFetchAt: 0,
    }),
}))
